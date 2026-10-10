import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { cancelTask, pauseTask, resumeTask, isRunningInProcess } from "@/server/agents/runner";
import { db } from "@/server/db";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ action: z.enum(["pause", "resume", "cancel"]) });

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
      select: { id: true, status: true },
    });
    if (!task) return jsonError(404, "not_found", "任务不存在或无权访问");

    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return jsonError(400, "invalid_input", "action 不合法");

    const inProcess = isRunningInProcess(taskId);
    let message = "";

    if (parsed.data.action === "pause") {
      if (!inProcess) return jsonError(409, "not_running", "任务不在运行中(可能已完成或服务重启)");
      pauseTask(taskId);
      await db.agentTask.update({ where: { id: taskId }, data: { status: "paused" } });
      message = "任务已暂停";
    } else if (parsed.data.action === "resume") {
      if (!inProcess) return jsonError(409, "not_running", "任务不在运行中,无法恢复");
      resumeTask(taskId);
      await db.agentTask.update({
        where: { id: taskId },
        data: { status: "coding" },
      });
      message = "任务已恢复";
    } else {
      cancelTask(taskId);
      // 状态由 runner 收尾写入;若任务已不在进程内,直接标记
      if (!isRunningInProcess(taskId)) {
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
