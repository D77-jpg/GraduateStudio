import { db } from "@/server/db";
import type { Change, ChangeSet } from "@prisma/client";
import {
  deleteFile,
  fileExists,
  normalizeRelPath,
  readFileContent,
  writeFileContent,
  WorkspaceFileError,
} from "@/server/workspace/files";
import { logActivity } from "@/server/activity";
import type { ChangeAction } from "@/lib/develop";

/**
 * 变更集服务:
 * - AI 生成 pending 变更集(Diff 预览)→ 用户 Accept 才写盘 / Reject 丢弃
 * - 手动编辑保存同样落 ChangeSet(source=manual,即时 accepted),全程可追溯
 * - Undo 撤销最近一次已应用变更集(写盘回滚);Restore 恢复最近一次被撤销的变更集
 */

export class ChangeSetAccessError extends Error {}
export class ChangeSetStateError extends Error {}

export interface ChangeSetDto {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  plan: Array<{ action: ChangeAction; path: string; reason?: string }>;
  source: string;
  status: "pending" | "accepted" | "rejected" | "undone";
  createdAt: string;
  appliedAt: string | null;
  changes: Array<{
    id: string;
    path: string;
    action: ChangeAction;
    beforeContent: string | null;
    afterContent: string | null;
  }>;
}

function toDto(changeSet: ChangeSet, changes: Change[]): ChangeSetDto {
  return {
    id: changeSet.id,
    projectId: changeSet.projectId,
    title: changeSet.title,
    summary: changeSet.summary,
    plan: safeParsePlan(changeSet.plan),
    source: changeSet.source,
    status: changeSet.status as ChangeSetDto["status"],
    createdAt: changeSet.createdAt.toISOString(),
    appliedAt: changeSet.appliedAt?.toISOString() ?? null,
    changes: changes.map((change) => ({
      id: change.id,
      path: change.path,
      action: change.action as ChangeAction,
      beforeContent: change.beforeContent,
      afterContent: change.afterContent,
    })),
  };
}

function safeParsePlan(
  raw: string,
): Array<{ action: ChangeAction; path: string; reason?: string }> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed))
      return parsed as Array<{ action: ChangeAction; path: string; reason?: string }>;
  } catch {
    // 脏数据兜底
  }
  return [];
}

async function loadOwnedChangeSet(changeSetId: string, userId: string) {
  const changeSet = await db.changeSet.findFirst({
    where: { id: changeSetId, project: { userId } },
    include: { changes: true },
  });
  if (!changeSet) throw new ChangeSetAccessError("变更集不存在或无权访问");
  return changeSet;
}

/** 把一组变更落盘(create/modify 写文件,delete 删文件)。调用方负责校验状态。 */
async function applyChangesToDisk(
  projectId: string,
  userId: string,
  changes: Change[],
): Promise<void> {
  for (const change of changes) {
    const action = change.action as ChangeAction;
    if (action === "delete") {
      deleteFile(projectId, userId, change.path);
    } else {
      const content = change.afterContent ?? "";
      writeFileContent(projectId, userId, change.path, content);
    }
  }
}

/** 计算单个文件的变更动作:不存在=create,内容一致=无变更,否则=modify。 */
export function resolveAction(before: string | null, after: string): ChangeAction | null {
  if (before === null) return "create";
  return before === after ? null : "modify";
}

/** 创建 pending 变更集(AI 实现 Phase 产出后调用)。beforeContent 取当前磁盘内容。 */
export async function createPendingChangeSet(input: {
  projectId: string;
  userId: string;
  title: string;
  summary: string;
  plan: Array<{ action: ChangeAction; path: string; reason?: string }>;
  changes: Array<{ path: string; action: ChangeAction; content: string }>;
}): Promise<ChangeSetDto> {
  const { projectId, userId } = input;
  const seen = new Map<string, ChangeAction>();

  for (const change of input.changes) {
    const path = normalizeRelPath(change.path);
    if (seen.has(path)) throw new ChangeSetStateError(`变更集中存在重复路径: ${path}`);
    seen.set(path, change.action);
  }

  const rows: Array<{
    path: string;
    action: ChangeAction;
    beforeContent: string | null;
    afterContent: string | null;
  }> = [];

  for (const change of input.changes) {
    const path = normalizeRelPath(change.path);
    if (change.action === "delete") {
      const before = fileExists(projectId, userId, path)
        ? readFileContent(projectId, userId, path).content
        : null;
      if (before === null) throw new ChangeSetStateError(`无法删除不存在的文件: ${path}`);
      rows.push({ path, action: "delete", beforeContent: before, afterContent: null });
      continue;
    }
    const before = fileExists(projectId, userId, path)
      ? readFileContent(projectId, userId, path).content
      : null;
    rows.push({
      path,
      action: resolveAction(before, change.content) ?? "modify",
      beforeContent: before,
      afterContent: change.content,
    });
  }

  if (rows.length === 0) {
    throw new ChangeSetStateError("没有任何实际变更");
  }

  const changeSet = await db.changeSet.create({
    data: {
      projectId,
      title: input.title,
      summary: input.summary,
      plan: JSON.stringify(input.plan),
      source: "ai",
      status: "pending",
      changes: {
        create: rows.map((row) => ({
          path: row.path,
          action: row.action,
          beforeContent: row.beforeContent,
          afterContent: row.afterContent,
        })),
      },
    },
    include: { changes: true },
  });

  await logActivity(
    projectId,
    "ai",
    `AI 生成变更集:${input.title}`,
    `涉及 ${rows.length} 个文件,等待确认`,
  );
  return toDto(changeSet, changeSet.changes);
}

/** 手动编辑保存:直接写盘并记录为已接受的变更集。 */
export async function recordManualChange(input: {
  projectId: string;
  userId: string;
  path: string;
  content: string;
}): Promise<ChangeSetDto> {
  const { projectId, userId } = input;
  const path = normalizeRelPath(input.path);
  const before = fileExists(projectId, userId, path)
    ? readFileContent(projectId, userId, path).content
    : null;
  const action = resolveAction(before, input.content);
  if (action === null) {
    // 内容未变化,不产生变更记录
    const empty = await db.changeSet.create({
      data: {
        projectId,
        title: `编辑 ${path}(无变化)`,
        source: "manual",
        status: "accepted",
        appliedAt: new Date(),
        changes: {
          create: { path, action: "modify", beforeContent: before, afterContent: input.content },
        },
      },
      include: { changes: true },
    });
    return toDto(empty, empty.changes);
  }

  writeFileContent(projectId, userId, path, input.content);
  const changeSet = await db.changeSet.create({
    data: {
      projectId,
      title: `${action === "create" ? "创建" : "编辑"} ${path}`,
      source: "manual",
      status: "accepted",
      appliedAt: new Date(),
      changes: {
        create: { path, action, beforeContent: before, afterContent: input.content },
      },
    },
    include: { changes: true },
  });
  await logActivity(
    projectId,
    "file",
    `保存文件 ${path}`,
    action === "create" ? "新建文件" : "手动编辑",
  );
  return toDto(changeSet, changeSet.changes);
}

/** 手动删除文件:写盘 + 留痕。 */
export async function recordManualDelete(input: {
  projectId: string;
  userId: string;
  path: string;
}): Promise<ChangeSetDto> {
  const { projectId, userId } = input;
  const path = normalizeRelPath(input.path);
  if (!fileExists(projectId, userId, path)) throw new WorkspaceFileError(`文件不存在: ${path}`);
  const before = readFileContent(projectId, userId, path).content;

  deleteFile(projectId, userId, path);
  const changeSet = await db.changeSet.create({
    data: {
      projectId,
      title: `删除 ${path}`,
      source: "manual",
      status: "accepted",
      appliedAt: new Date(),
      changes: { create: { path, action: "delete", beforeContent: before, afterContent: null } },
    },
    include: { changes: true },
  });
  await logActivity(projectId, "file", `删除文件 ${path}`);
  return toDto(changeSet, changeSet.changes);
}

/** Accept:pending 变更集写盘生效。 */
export async function acceptChangeSet(changeSetId: string, userId: string): Promise<ChangeSetDto> {
  const changeSet = await loadOwnedChangeSet(changeSetId, userId);
  if (changeSet.status !== "pending") {
    throw new ChangeSetStateError("只有待确认的变更集可以接受");
  }
  await applyChangesToDisk(changeSet.projectId, userId, changeSet.changes);
  const updated = await db.changeSet.update({
    where: { id: changeSet.id },
    data: { status: "accepted", appliedAt: new Date() },
    include: { changes: true },
  });
  await logActivity(
    changeSet.projectId,
    "file",
    `应用变更集:${changeSet.title}`,
    `写入 ${changeSet.changes.length} 个文件`,
  );
  return toDto(updated, updated.changes);
}

/** Reject:丢弃 pending 变更集,不写盘。 */
export async function rejectChangeSet(changeSetId: string, userId: string): Promise<ChangeSetDto> {
  const changeSet = await loadOwnedChangeSet(changeSetId, userId);
  if (changeSet.status !== "pending") {
    throw new ChangeSetStateError("只有待确认的变更集可以拒绝");
  }
  const updated = await db.changeSet.update({
    where: { id: changeSet.id },
    data: { status: "rejected" },
    include: { changes: true },
  });
  await logActivity(changeSet.projectId, "ai", `拒绝变更集:${changeSet.title}`);
  return toDto(updated, updated.changes);
}

/** Undo:撤销最近一次已应用(且未被撤销)的变更集,写盘回滚。 */
export async function undoLatestChangeSet(
  projectId: string,
  userId: string,
): Promise<ChangeSetDto> {
  const target = await db.changeSet.findFirst({
    where: { projectId, project: { userId }, status: "accepted" },
    orderBy: { appliedAt: "desc" },
    include: { changes: true },
  });
  if (!target) throw new ChangeSetStateError("没有可撤销的变更");

  for (const change of target.changes) {
    const action = change.action as ChangeAction;
    if (action === "create") {
      deleteFile(projectId, userId, change.path);
    } else if (action === "modify") {
      if (change.beforeContent !== null) {
        writeFileContent(projectId, userId, change.path, change.beforeContent);
      }
    } else if (action === "delete") {
      if (change.beforeContent !== null) {
        writeFileContent(projectId, userId, change.path, change.beforeContent);
      }
    }
  }

  const updated = await db.changeSet.update({
    where: { id: target.id },
    data: { status: "undone" },
    include: { changes: true },
  });
  await logActivity(
    projectId,
    "file",
    `撤销变更集:${target.title}`,
    `回滚 ${target.changes.length} 个文件`,
  );
  return toDto(updated, updated.changes);
}

/** Restore:恢复最近一次被撤销的变更集(重新写盘)。 */
export async function restoreChangeSet(changeSetId: string, userId: string): Promise<ChangeSetDto> {
  const changeSet = await loadOwnedChangeSet(changeSetId, userId);
  if (changeSet.status !== "undone") {
    throw new ChangeSetStateError("只有被撤销的变更集可以恢复");
  }
  // 必须是最近一次撤销的变更集,避免乱序恢复
  const latestUndone = await db.changeSet.findFirst({
    where: { projectId: changeSet.projectId, project: { userId }, status: "undone" },
    orderBy: { appliedAt: "desc" },
    select: { id: true },
  });
  if (latestUndone?.id !== changeSet.id) {
    throw new ChangeSetStateError("只能按顺序恢复最近撤销的变更集");
  }

  await applyChangesToDisk(changeSet.projectId, userId, changeSet.changes);
  const updated = await db.changeSet.update({
    where: { id: changeSet.id },
    data: { status: "accepted", appliedAt: new Date() },
    include: { changes: true },
  });
  await logActivity(changeSet.projectId, "file", `恢复变更集:${changeSet.title}`);
  return toDto(updated, updated.changes);
}

export async function listChangeSets(
  projectId: string,
  userId: string,
  limit = 30,
): Promise<ChangeSetDto[]> {
  const project = await db.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!project) throw new ChangeSetAccessError("项目不存在或无权访问");

  const rows = await db.changeSet.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { changes: true },
  });
  return rows.map((row) => toDto(row, row.changes));
}

export async function getLatestPendingChangeSet(
  projectId: string,
  userId: string,
): Promise<ChangeSetDto | null> {
  const pending = await db.changeSet.findFirst({
    where: { projectId, project: { userId }, status: "pending" },
    orderBy: { createdAt: "desc" },
    include: { changes: true },
  });
  return pending ? toDto(pending, pending.changes) : null;
}
