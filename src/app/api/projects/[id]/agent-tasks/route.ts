import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner, buildCodingContext } from "@/server/agents/context";
import { detectSupportedGenerationStack } from "@/lib/stack-preflight";
import { startAgentTask, isRunningInProcess, reapOrphanTasks } from "@/server/agents/runner";
import { getAiStatus } from "@/server/ai";
import {
  loadCodexCheckpoint,
  codexExecutionMetadata,
  codexPlanProgress,
} from "@/server/agents/codex-checkpoint";
import { isCodexPostApplyVerificationRunning } from "@/server/agents/codex-post-apply";
import { logActivity } from "@/server/activity";
import { db } from "@/server/db";
import { agentTaskDtoSchema } from "@/lib/agent";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** 任务列表(含步骤;前端轮询用)。顺带清理孤儿任务。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    await reapOrphanTasks(id);

    const rows = await db.agentTask.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { steps: { orderBy: { index: "asc" } } },
    });

    const tasks = await Promise.all(
      rows.map(async (row) => {
        let checkpoint = await loadCodexCheckpoint(id, row.id);
        if (checkpoint?.phase === "awaiting_acceptance") {
          const { reconcileCodexReview } = await import("@/server/agents/codex-review");
          await reconcileCodexReview(id, row.id);
          checkpoint = await loadCodexCheckpoint(id, row.id);
          if (checkpoint?.phase === "cancelled") row.status = "cancelled";
        }
        return agentTaskDtoSchema.parse({
          ...row,
          execution: checkpoint
            ? { ...codexExecutionMetadata(checkpoint), plan: await codexPlanProgress(checkpoint) }
            : null,
          createdAt: row.createdAt.toISOString(),
          startedAt: row.startedAt?.toISOString() ?? null,
          finishedAt: row.finishedAt?.toISOString() ?? null,
          steps: row.steps.map((s) => ({
            ...s,
            createdAt: s.createdAt.toISOString(),
            finishedAt: s.finishedAt?.toISOString() ?? null,
          })),
        });
      }),
    );
    const runningTaskIds = tasks
      .filter((task) => isRunningInProcess(task.id) || isCodexPostApplyVerificationRunning(task.id))
      .map((task) => task.id);
    const anyRunning = runningTaskIds.length > 0;
    return NextResponse.json({ tasks, anyRunning, runningTaskIds });
  } catch (error) {
    return handleRouteError("agent-tasks.list", error);
  }
}

const bodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("full"), message: z.string().trim().max(2000).optional() }),
  z.object({
    mode: z.literal("local"),
    message: z.string().trim().min(5, "任务描述太短,请至少 5 个字符").max(2000),
    // Compatibility-only: old clients may send a limit; it is ignored.
    maxSteps: z.unknown().optional(),
  }),
]);

/** 创建并启动自主开发任务。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    // Codex owns container/key readiness; it must not require the legacy provider.
    if (process.env.GRADUATESTUDIO_AGENT_ENGINE !== "codex" && !getAiStatus().configured)
      return jsonError(503, "ai_not_configured", "尚未配置 AI Provider");

    // 并发限制:同一项目同时只允许一个运行中的任务
    const running = await db.agentTask.findFirst({
      where: {
        projectId: id,
        status: {
          in: ["queued", "analyzing", "planning", "coding", "checking", "fixing", "paused"],
        },
      },
      select: { id: true },
    });
    if (running) {
      return jsonError(
        409,
        "task_running",
        "已有正在运行的自主开发任务,请等待完成或取消后再发起新任务",
      );
    }

    const raw: unknown = await request.json();
    const parsed = bodySchema.safeParse(
      raw && typeof raw === "object" ? { ...raw, mode: "mode" in raw ? raw.mode : "local" } : raw,
    );
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "输入不合法");
    }
    const mode = parsed.data.mode;
    if (mode === "full") {
      const requirement = await db.requirement.findUnique({
        where: { projectId: id },
        select: { id: true, _count: { select: { features: true } } },
      });
      if (!requirement || requirement._count.features === 0)
        return jsonError(
          400,
          "requirements_required",
          "请先保存需求分析与功能范围，再发起完整项目生成。",
        );
      const context = await buildCodingContext(id, session.user.id);
      const preflight = detectSupportedGenerationStack(
        `${context.projectText}\n${context.architectureText}`,
      );
      if (!preflight.supported)
        return jsonError(
          400,
          "unsupported_generation_stack",
          preflight.reason ?? "当前技术栈没有完整工程验收支持，尚未调用模型。",
        );
    }
    const message =
      mode === "full"
        ? `根据已保存需求与技术栈自动实现完整项目，包含前后端联调、持久化、测试、构建与交付说明。${parsed.data.message ? `补充要求：${parsed.data.message}` : ""}`
        : parsed.data.message;
    // Retained for legacy storage / runner signature only, never an execution limit.
    const maxSteps = mode === "full" ? 240 : 18;

    const task = await db.$transaction(async (tx) => {
      const occupied = await tx.agentTask.findFirst({
        where: {
          projectId: id,
          status: {
            in: ["queued", "analyzing", "planning", "coding", "checking", "fixing", "paused"],
          },
        },
        select: { id: true },
      });
      if (occupied) return null;
      return tx.agentTask.create({
        data: {
          projectId: id,
          message,
          maxSteps,
          status: "queued",
          title: mode === "full" ? "[完整生成] 自动完成项目" : message.slice(0, 40),
        },
      });
    });
    if (!task) return jsonError(409, "task_running", "项目已有任务，请查看现有进度或从断点继续。");
    await logActivity(id, "ai", `发起自主开发任务:${message.slice(0, 60)}`, `mode=${mode}`);

    const started = startAgentTask(task, id, session.user.id, message, maxSteps, mode);
    if (!started) {
      await db.agentTask.update({
        where: { id: task.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          error: "项目执行器已被占用，未发起模型调用。",
        },
      });
      return jsonError(409, "task_running", "项目已有执行器运行，请查看现有任务。");
    }

    return NextResponse.json({ task: { id: task.id, status: task.status } }, { status: 201 });
  } catch (error) {
    return handleRouteError("agent-tasks.create", error);
  }
}
