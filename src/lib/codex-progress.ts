export const CODEX_PROGRESS_PREFIX = "CODEX_PROGRESS\n";
export interface CodexProgress {
  files: string[];
  latest: string;
  updatedAt?: string;
  engine?: string;
  model?: string;
}
export function parseCodexProgress(detail: string): CodexProgress | null {
  if (!detail.startsWith(CODEX_PROGRESS_PREFIX)) return null;
  try {
    const value = JSON.parse(detail.slice(CODEX_PROGRESS_PREFIX.length));
    return Array.isArray(value.files) &&
      value.files.every((p: unknown) => typeof p === "string") &&
      typeof value.latest === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
export function safeCodexText(text: string): string {
  return text
    .replace(/(?:sk|wb)-[\w-]+/gi, "[已隐藏密钥]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [已隐藏]")
    .replace(/((?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*)[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/(authorization\s*[:=]\s*)([^\r\n]+)/gi, "$1[已隐藏]")
    .slice(0, 3000);
}
export function commandPurpose(command: string): string {
  if (/npm\s+(ci|install)|pnpm\s+install/i.test(command)) return "准备当前项目依赖";
  if (/\b(build|vite build)\b/i.test(command)) return "检查项目构建";
  if (/\b(test|vitest)\b/i.test(command)) return "执行自动化测试";
  if (/Get-Content|readFile|\bcat\b|Show-Blocks/i.test(command)) return "阅读代码与页面结构";
  if (/Get-ChildItem|readdir|\bls\b|\bdir\b/i.test(command)) return "检查项目文件结构";
  if (/Set-Content|writeFile|apply_patch/i.test(command)) return "修改项目文件";
  return "执行项目检查（详情可展开）";
}
export function describeCodexTool(
  raw: unknown,
  started: boolean,
): { message: string; detail: string } {
  const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const label = started
    ? "执行中"
    : item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0)
      ? "执行失败"
      : "已返回";
  if (item.type === "command_execution") {
    return {
      message: `Codex ${commandPurpose(String(item.command ?? ""))} · ${label}`,
      detail: safeCodexText(
        `技术命令：${String(item.command ?? "")}\n退出码：${item.exit_code ?? "待返回"}\n输出：${String(item.aggregated_output ?? "")}`,
      ),
    };
  }
  if (item.type === "file_change") {
    const paths = Array.isArray(item.changes)
      ? item.changes
          .map((c) => (c && typeof c === "object" ? String(c.path ?? "") : ""))
          .filter(Boolean)
      : [];
    return {
      message: safeCodexText(`Codex 文件修改${label}：${paths.join("、") || "待审计"}`).slice(
        0,
        450,
      ),
      detail: "发生在隔离副本；实际文件差异审计后才应用到原项目。",
    };
  }
  const name = String(item.tool ?? item.name ?? item.type ?? "未知工具");
  return {
    message: safeCodexText(`Codex ${name} ${label}`).slice(0, 450),
    detail: safeCodexText(`状态：${item.status ?? label}`),
  };
}
