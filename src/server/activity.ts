import { db } from "@/server/db";

/** 项目活动日志:Terminal 命令、AI 调用、文件修改、系统事件统一留痕。 */

export type ActivityKind = "ai" | "terminal" | "file" | "system";

export async function logActivity(
  projectId: string,
  kind: ActivityKind,
  message: string,
  detail = "",
): Promise<void> {
  try {
    await db.activityLog.create({
      data: { projectId, kind, message: message.slice(0, 500), detail: detail.slice(0, 4000) },
    });
  } catch (error) {
    // 日志失败不应阻断主流程
    console.error("[activity-log] write failed:", error);
  }
}

export async function listActivityLogs(projectId: string, userId: string, limit = 100) {
  const project = await db.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!project) throw new Error("项目不存在或无权访问");

  const logs = await db.activityLog.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return logs.map((log) => ({
    id: log.id,
    kind: log.kind,
    message: log.message,
    detail: log.detail,
    createdAt: log.createdAt.toISOString(),
  }));
}
