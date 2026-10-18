import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { loadCodexCheckpoint } from "@/server/agents/codex-checkpoint";
import { db } from "@/server/db";
import { collectRuntimeRepairEvidence } from "@/server/runtime/codex-runtime-diagnostics";

export const dynamic = "force-dynamic";

// Read the runner's existing registry without importing its model-execution graph.
const runtimeGlobal = globalThis as typeof globalThis & {
  graduateStudioAgentControllers?: Map<string, unknown>;
  graduateStudioRuntimeDiagnoses?: Map<string, true>;
};
const diagnoses = (runtimeGlobal.graduateStudioRuntimeDiagnoses ??= new Map<string, true>());
const inProcess = (taskId: string) =>
  runtimeGlobal.graduateStudioAgentControllers?.has(taskId) ?? false;
const headers = { "Cache-Control": "no-store" };
const jsonError = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { code, message } }, { status, headers });

/** Observation only: the stored task message is the sole diagnostic input. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  let lockKey: string | undefined;
  try {
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");
    const { id, taskId } = await params;
    // Ownership must precede task/checkpoint/runtime inspection, including lock inspection.
    try {
      await assertProjectOwner(id, session.user.id);
    } catch {
      return jsonError(404, "not_found", "项目不存在或无权访问");
    }
    if (!taskId) return jsonError(400, "invalid_input", "缺少任务 ID");
    const task = await db.agentTask.findFirst({
      where: { id: taskId, projectId: id, project: { userId: session.user.id } },
      select: { message: true },
    });
    if (!task) return jsonError(404, "not_found", "任务不存在或无权访问");
    const key = JSON.stringify([id, taskId]);
    if (inProcess(taskId) || diagnoses.has(key))
      return jsonError(409, "task_running", "任务或故障复核仍在运行中，请稍后重试");
    diagnoses.set(key, true);
    lockKey = key;

    const checkpoint = await loadCodexCheckpoint(id, taskId);
    if (checkpoint?.mode === "full")
      return jsonError(400, "unsupported_mode", "仅支持局部开发任务的运行故障复核");
    // Never read request.json(): prompts, URLs and configuration cannot be supplied here.
    const report = await collectRuntimeRepairEvidence(id, task.message, request.signal);
    if (!report) return jsonError(400, "not_runtime_repair", "原任务未包含可复核的业务任务故障");
    request.signal.throwIfAborted();
    if (inProcess(taskId)) return jsonError(409, "task_running", "任务已开始运行，请稍后重试");
    // AgentStep has a non-unique (taskId, index) index. The per-task lock serializes
    // this route's index allocation; no task status or checkpoint is changed.
    const lastStep = await db.agentStep.findFirst({
      where: { taskId },
      orderBy: { index: "desc" },
      select: { index: true },
    });
    await db.agentStep.create({
      data: {
        taskId,
        index: (lastStep?.index ?? -1) + 1,
        kind: "note",
        status: "done",
        title: "运行故障复核",
        detail: "RUNTIME_REPAIR_REPORT\n" + JSON.stringify(report),
        finishedAt: new Date(),
      },
    });
    return NextResponse.json({ report }, { headers });
  } catch {
    return jsonError(500, "internal", "运行故障复核未完成，请稍后重试");
  } finally {
    if (lockKey !== undefined) diagnoses.delete(lockKey);
  }
}
