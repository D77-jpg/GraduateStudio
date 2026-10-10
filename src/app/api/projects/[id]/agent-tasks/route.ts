import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { startAgentTask, isRunningInProcess, reapOrphanTasks } from "@/server/agents/runner";
import { getAiStatus } from "@/server/ai";
import { logActivity } from "@/server/activity";
import { db } from "@/server/db";
import { agentTaskDtoSchema, isActiveStatus } from "@/lib/agent";
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

    const tasks = rows.map((row) =>
      agentTaskDtoSchema.parse({
        ...row,
        createdAt: row.createdAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        steps: row.steps.map((s) => ({
          ...s,
          createdAt: s.createdAt.toISOString(),
          finishedAt: s.finishedAt?.toISOString() ?? null,
        })),
      }),
    );
    const anyRunning = tasks.some((t) => isActiveStatus(t.status) && isRunningInProcess(t.id));
    return NextResponse.json({ tasks, anyRunning });
  } catch (error) {
    return handleRouteError("agent-tasks.list", error);
  }
}

const bodySchema = z.object({
  message: z.string().trim().min(5, "任务描述太短,请至少 5 个字符").max(2000),
  maxSteps: z.number().int().min(3).max(30).default(12),
});

/** 创建并启动自主开发任务。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const ai = getAiStatus();
    if (!ai.configured) return jsonError(503, "ai_not_configured", "尚未配置 AI Provider");

    // 并发限制:同一项目同时只允许一个运行中的任务
    const running = await db.agentTask.findFirst({
      where: {
        projectId: id,
        status: { in: ["queued", "analyzing", "planning", "coding", "checking", "fixing"] },
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

    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "输入不合法");
    }
    const { message, maxSteps } = parsed.data;

    const task = await db.agentTask.create({
      data: {
        projectId: id,
        message,
        maxSteps,
        status: "queued",
        title: message.slice(0, 40),
      },
    });
    await logActivity(id, "ai", `发起自主开发任务:${message.slice(0, 60)}`, `maxSteps=${maxSteps}`);

    startAgentTask(task, id, session.user.id, message, maxSteps);

    return NextResponse.json({ task: { id: task.id, status: task.status } }, { status: 201 });
  } catch (error) {
    return handleRouteError("agent-tasks.create", error);
  }
}
