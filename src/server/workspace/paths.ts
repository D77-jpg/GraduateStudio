import fs from "node:fs";
import path from "node:path";

/**
 * 用户毕业设计项目工作区的路径工具。
 * Agent 生成的所有项目文件都存放在 WORKSPACE_ROOT 下,每个项目一个子目录。
 * 所有对外路径必须经过本项目函数解析,防止路径穿越(workspace 沙箱边界)。
 */

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

/** 项目标识符:仅允许字母、数字、下划线、连字符(防止目录名注入)。 */
export const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function getWorkspaceRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env.WORKSPACE_ROOT?.trim();
  const root =
    configured && configured.length > 0 ? configured : path.join(process.cwd(), ".workspace");
  return path.resolve(root);
}

/** 校验 projectId 并解析为 root 下的项目目录(不创建目录)。 */
export function resolveProjectDir(projectId: string, root: string = getWorkspaceRoot()): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new WorkspacePathError(`非法的项目标识符: ${projectId}`);
  }
  const dir = path.resolve(root, projectId);
  ensureWithinRoot(root, dir);
  return dir;
}

/** 解析并确保项目目录存在。 */
export function ensureProjectDir(projectId: string, root: string = getWorkspaceRoot()): string {
  const dir = resolveProjectDir(projectId, root);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 在 baseDir 内安全拼接相对路径。
 * 任何通过 `..`、绝对路径等手段逃逸出 baseDir 的输入都会被拒绝。
 */
export function safeJoin(baseDir: string, ...segments: string[]): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, ...segments);
  ensureWithinRoot(base, target);
  return target;
}

function ensureWithinRoot(root: string, target: string): void {
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new WorkspacePathError(`路径越界: ${target} 不在 ${base} 内`);
  }
}
