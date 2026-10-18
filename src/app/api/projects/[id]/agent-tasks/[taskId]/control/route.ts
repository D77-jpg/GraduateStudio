import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { cancelTask, pauseTask, resumeTask, isRunningInProcess } from "@/server/agents/runner";
import { db } from "@/server/db";
import { loadCodexCheckpoint, saveCodexCheckpoint } from "@/server/agents/codex-checkpoint";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "retry", "extend-budget", "verify"]),
});

/** 任务控制:暂停 / 恢复 / 取消。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    const { id, taskId } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);

    const task = await db.agentTask.findFirst({
      where: { id: taskId, projectId: id, project: { userId: session.user.id } },
      include: { steps: { select: { detail: true } } },
    });
    if (!task) return jsonError(404, "not_found", "任务不存在或无权访问");

    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return jsonError(400, "invalid_input", "action 不合法");

    const inProcess = isRunningInProcess(taskId);
    let checkpoint = await loadCodexCheckpoint(id, taskId);
    if (checkpoint?.phase === "awaiting_acceptance") {
      const { reconcileCodexReview } = await import("@/server/agents/codex-review");
      await reconcileCodexReview(id, taskId);
      checkpoint = await loadCodexCheckpoint(id, taskId);
    }
    if (parsed.data.action === "verify") {
      if (checkpoint?.phase !== "applied_unverified" || task.status === "cancelled")
        return jsonError(409, "not_applied", "请先接受代码变更后再验证。");
      const { startCodexPostApplyVerification } = await import("@/server/agents/codex-post-apply");
      const started = await startCodexPostApplyVerification(id, taskId, session.user.id);
      return NextResponse.json({
        ok: true,
        started,
        message: started ? "已开始验证已应用的代码；不会自动调用模型。" : "验证已在进行中。",
      });
    }
    const reviewPending =
      checkpoint &&
      (checkpoint.pendingChangeSetId ||
        ["awaiting_acceptance", "applied_unverified"].includes(checkpoint.phase));
    if (checkpoint?.phase === "applied_unverified" && parsed.data.action === "cancel") {
      const { isCodexPostApplyVerificationRunning, cancelCodexPostApplyVerification } =
        await import("@/server/agents/codex-post-apply");
      if (isCodexPostApplyVerificationRunning(taskId)) {
        cancelCodexPostApplyVerification(taskId);
        return NextResponse.json({
          ok: true,
          message: "正在停止验证；文件不会撤销，任务仍待验收。",
        });
      }
      checkpoint.phase = "cancelled";
      checkpoint.error = "用户结束已应用但未验收的任务；不撤销文件，也不表示验收完成。";
      await db.agentTask.update({
        where: { id: taskId },
        data: { status: "cancelled", error: checkpoint.error, finishedAt: new Date() },
      });
      await saveCodexCheckpoint(checkpoint);
      return NextResponse.json({ ok: true, message: checkpoint.error });
    }
    if (reviewPending)
      return jsonError(
        409,
        "review_required",
        "代码正在等待审核或已应用但未验收，请在开发工作区处理；不能重新运行模型。",
      );
    let message = "";

    if (
      parsed.data.action === "retry" ||
      parsed.data.action === "extend-budget" ||
      (parsed.data.action === "resume" && !inProcess)
    ) {
      if (inProcess)
        return jsonError(409, "task_running", "任务仍在运行中，请使用恢复或等待结束。");
      if (task.status === "completed" || task.status === "cancelled")
        return jsonError(409, "task_terminal", "已完成或取消的任务不能继续，请按需发起新任务。");
      if (
        !checkpoint &&
        !task.steps.some((step) => step.detail.startsWith("FULL_PROJECT_CHECKPOINT\n"))
      )
        return jsonError(409, "no_checkpoint", "该任务没有可安全恢复的应用检查点。");
      const other = await db.agentTask.findFirst({
        where: {
          projectId: id,
          id: { not: taskId },
          status: {
            in: ["queued", "analyzing", "planning", "coding", "checking", "fixing", "paused"],
          },
        },
        select: { id: true },
      });
      if (other) return jsonError(409, "task_running", "项目已有另一个任务，请先处理该任务。");
      const { resumeAgentTask } = await import("@/server/agents/runner");
      // extend-budget is a legacy alias for retry, not an allowance change.
      const resumed = await resumeAgentTask(task, id, session.user.id);
      if (!resumed) return jsonError(409, "task_running", "任务已经在执行中。");
      return NextResponse.json({
        ok: true,
        message: "已从应用检查点发起新尝试（不保证延续模型会话）",
      });
    }
    if (parsed.data.action === "pause") {
      if (!inProcess) return jsonError(409, "not_running", "任务不在运行中(可能已完成或服务重启)");
      pauseTask(taskId);
      await db.agentTask.update({ where: { id: taskId }, data: { status: "paused" } });
      message = "任务已暂停";
    } else if (parsed.data.action === "resume") {
      if (!inProcess) return jsonError(409, "not_running", "任务不在运行中,无法恢复");
      if (!resumeTask(taskId))
        return jsonError(
          409,
          "task_settling",
          "Codex 正在停止，请等待本次进程退出后再从检查点继续。",
        );
      await db.agentTask.update({
        where: { id: taskId },
        data: { status: "coding" },
      });
      message = "任务已恢复";
    } else {
      cancelTask(taskId);
      // 状态由 runner 收尾写入;若任务已不在进程内,直接标记
      if (!isRunningInProcess(taskId)) {
        if (checkpoint) {
          checkpoint.phase = "cancelled";
          checkpoint.error = null;
          await saveCodexCheckpoint(checkpoint);
        }
        await db.agentTask.update({
          where: { id: taskId },
          data: { status: "cancelled", finishedAt: new Date(), error: "任务被用户取消" },
        });
      }
      message = "任务已取消";
    }

    return NextResponse.json({ ok: true, message });
  } catch (error) {
    return handleRouteError("agent-tasks.control", error);
  }
}
