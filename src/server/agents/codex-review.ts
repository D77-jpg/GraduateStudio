import { db } from "@/server/db";
import { loadCodexCheckpoint, saveCodexCheckpoint } from "./codex-checkpoint";

/** Idempotent projection after human review; application is not business acceptance. */
export async function reconcileCodexReview(projectId: string, taskId: string): Promise<void> {
  const cp = await loadCodexCheckpoint(projectId, taskId);
  if (!cp?.pendingChangeSetId || cp.phase !== "awaiting_acceptance") return;
  const proposal = await db.changeSet.findFirst({
    where: { id: cp.pendingChangeSetId, projectId },
    select: { status: true },
  });
  if (!proposal || proposal.status === "pending") return;
  if (proposal.status === "accepted") {
    cp.phase = "applied_unverified";
    cp.error = "用户已接受文件变更；平台独立构建、测试及业务验收尚未执行，不代表可交付。";
    await db.agentTask.update({
      where: { id: taskId },
      data: { status: "paused", error: cp.error, finishedAt: null },
    });
    await saveCodexCheckpoint(cp);
  } else if (proposal.status === "rejected" || proposal.status === "undone") {
    cp.phase = "cancelled";
    cp.error = "用户已拒绝或撤销变更；副本保留，未声明开发完成。";
    await db.agentTask.update({
      where: { id: taskId },
      data: { status: "cancelled", error: cp.error, finishedAt: new Date() },
    });
    await saveCodexCheckpoint(cp);
  }
}
