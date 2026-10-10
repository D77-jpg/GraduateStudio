import path from "node:path";
import { listFileTree, readFileContent, type FileNodeDto } from "./files";

/**
 * 全局内容搜索:在工作区内做带行号的子串匹配(忽略大小写可选),
 * 跳过二进制与超大文件,限制结果数量防止刷屏。
 */

export interface SearchHitDto {
  path: string;
  line: number;
  text: string;
}

export interface SearchResultDto {
  query: string;
  totalMatches: number;
  truncated: boolean;
  hits: SearchHitDto[];
}

const MAX_HITS = 100;

export function searchWorkspace(
  projectId: string,
  userId: string,
  query: string,
  options: { caseSensitive?: boolean } = {},
): SearchResultDto {
  const trimmed = query.trim();
  if (!trimmed) {
    return { query, totalMatches: 0, truncated: false, hits: [] };
  }

  const files = listFileTree(projectId, userId).filter((node) => node.type === "file");
  const needle = options.caseSensitive ? trimmed : trimmed.toLowerCase();
  const hits: SearchHitDto[] = [];
  let totalMatches = 0;
  let truncated = false;

  for (const file of files) {
    if (hits.length >= MAX_HITS) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      content = readFileContent(projectId, userId, file.path).content;
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue;

    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const haystack = options.caseSensitive ? line : line.toLowerCase();
      if (haystack.includes(needle)) {
        totalMatches++;
        if (hits.length < MAX_HITS) {
          hits.push({
            path: file.path,
            line: index + 1,
            text: line.trim().slice(0, 200),
          });
        } else {
          truncated = true;
        }
      }
    }
  }

  return { query: trimmed, totalMatches, truncated, hits };
}

/** 文件名过滤(文件搜索):在文件树中按名称子串匹配。 */
export function filterFilesByName(nodes: FileNodeDto[], query: string): FileNodeDto[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return nodes
    .filter((node) => node.type === "file" && node.name.toLowerCase().includes(needle))
    .slice(0, 50);
}

export function listProjectFilePaths(projectId: string, userId: string): string[] {
  try {
    return listFileTree(projectId, userId)
      .filter((node) => node.type === "file")
      .map((node) => node.path);
  } catch {
    return [];
  }
}

export function isTextFilePath(filePath: string): boolean {
  const binaryExtensions = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".jar",
    ".class",
    ".exe",
    ".dll",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".mp4",
    ".mp3",
  ]);
  const ext = path.extname(filePath).toLowerCase();
  return !binaryExtensions.has(ext);
}

export function readFileOrNull(projectId: string, userId: string, relPath: string): string | null {
  try {
    if (!isTextFilePath(relPath)) return null;
    return readFileContent(projectId, userId, relPath).content;
  } catch {
    return null;
  }
}
