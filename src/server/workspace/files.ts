import fs from "node:fs";
import path from "node:path";
import { ensureProjectDir, safeJoin } from "./paths";

/**
 * 工作区文件操作:目录树、读取、写入、删除。
 * 所有路径一律为项目目录内的相对路径(正斜杠),统一经过 safeJoin 防穿越;
 * node_modules 与 .git 永远不可读写。
 */

export class WorkspaceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
]);
export const MAX_READ_BYTES = 512 * 1024;
const MAX_TREE_ENTRIES = 2000;

export interface FileNodeDto {
  path: string;
  name: string;
  type: "file" | "dir";
}

/** 规范化相对路径并拒绝危险目标;返回正斜杠形式。 */
export function normalizeRelPath(input: string): string {
  const rel = input.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!rel) throw new WorkspaceFileError("路径不能为空");
  const segments = rel.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new WorkspaceFileError(`非法路径: ${input}`);
    }
    if (IGNORED_DIR_NAMES.has(segment.toLowerCase())) {
      throw new WorkspaceFileError(`不允许访问受保护目录: ${segment}`);
    }
  }
  return segments.join("/");
}

/** 递归列出项目文件树(忽略构建产物目录),按 目录优先、字母序 排列。 */
export function listFileTree(projectId: string, userId: string): FileNodeDto[] {
  void userId; // 归属校验在路由层完成
  const projectDir = ensureProjectDir(projectId);
  const results: FileNodeDto[] = [];

  const walk = (relDir: string) => {
    if (results.length >= MAX_TREE_ENTRIES) return;
    const absDir = relDir ? safeJoin(projectDir, relDir) : projectDir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = entries
      .filter((entry) => !IGNORED_DIR_NAMES.has(entry.name.toLowerCase()))
      .sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1;
        const bDir = b.isDirectory() ? 0 : 1;
        return aDir - bDir || a.name.localeCompare(b.name);
      });
    for (const entry of sorted) {
      if (results.length >= MAX_TREE_ENTRIES) return;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      results.push({
        path: relPath,
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file",
      });
      if (entry.isDirectory()) walk(relPath);
    }
  };

  walk("");
  return results;
}

// 归属校验由路由层完成;此处仅做路径解析与安全校验。

export interface FileContentDto {
  path: string;
  content: string;
  truncated: boolean;
}

export function readFileContent(
  projectId: string,
  userId: string,
  relPath: string,
): FileContentDto {
  const normalized = normalizeRelPath(relPath);
  const projectDir = ensureProjectDir(projectId);
  const absPath = safeJoin(projectDir, normalized);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    throw new WorkspaceFileError(`文件不存在: ${normalized}`);
  }
  const stat = fs.statSync(absPath);
  if (stat.size > MAX_READ_BYTES) {
    const raw = fs.readFileSync(absPath, "utf8").slice(0, MAX_READ_BYTES);
    return { path: normalized, content: raw, truncated: true };
  }
  return { path: normalized, content: fs.readFileSync(absPath, "utf8"), truncated: false };
}

export function fileExists(projectId: string, userId: string, relPath: string): boolean {
  try {
    const normalized = normalizeRelPath(relPath);
    const absPath = safeJoin(ensureProjectDir(projectId), normalized);
    return fs.existsSync(absPath) && fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

export function writeFileContent(
  projectId: string,
  userId: string,
  relPath: string,
  content: string,
): void {
  const normalized = normalizeRelPath(relPath);
  const absPath = safeJoin(ensureProjectDir(projectId), normalized);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
}

export function deleteFile(projectId: string, userId: string, relPath: string): void {
  const normalized = normalizeRelPath(relPath);
  const absPath = safeJoin(ensureProjectDir(projectId), normalized);
  if (fs.existsSync(absPath)) {
    fs.rmSync(absPath);
  }
}

/** 二进制/超大文件判定:含 NUL 字节即视为二进制,不适合作为文本 diff。 */
export function looksBinary(content: string): boolean {
  return content.includes("\u0000");
}
