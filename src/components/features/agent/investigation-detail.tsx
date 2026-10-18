"use client";

/** Presentation-only parsing: never import the server's investigation/tool implementation. */
type RecordValue = Record<string, unknown>;
type InvestigationDisplay = {
  kind: "observation" | "conclusion";
  heading: string;
  status: string;
  hypothesis?: string;
  paths: string[];
  summary: string;
  output?: string;
  outputLabel?: string;
  truncated?: boolean;
};

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function short(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const TOOLS: Record<string, string> = {
  read_file: "读取文件",
  list_files: "列出文件",
  search_text: "搜索文本",
  node_test: "定向 Node 测试",
};
const DISPOSITIONS: Record<string, string> = {
  repair: "建议修复（尚未修改代码）",
  environment: "环境阻塞",
  insufficient: "证据不足",
};

export function parseInvestigationDetail(detail: string): InvestigationDisplay | null {
  let value: RecordValue | null;
  try {
    value = record(JSON.parse(detail));
  } catch {
    return null;
  }
  if (!value) return null;
  const disposition = text(value.disposition);
  if (
    typeof value.checkId === "string" &&
    Object.hasOwn(DISPOSITIONS, disposition) &&
    typeof value.summary === "string" &&
    Array.isArray(value.paths)
  ) {
    return {
      kind: "conclusion",
      heading: `调查结论 · ${value.checkId}`,
      status: DISPOSITIONS[disposition],
      paths: value.paths.filter((path): path is string => typeof path === "string"),
      summary: short(value.summary),
      ...(value.summary.length > 240 ? { output: value.summary, outputLabel: "查看完整结论" } : {}),
    };
  }
  const request = record(value.request);
  const result = record(value.result);
  const tool = text(request?.tool);
  if (
    typeof value.hypothesis !== "string" ||
    number(value.id) === undefined ||
    !request ||
    !result ||
    !Object.hasOwn(TOOLS, tool)
  )
    return null;

  const blocked = text(result.blockedReason);
  const exitCode = number(result.exitCode);
  const status = blocked
    ? "工具受阻"
    : tool === "node_test" && exitCode === 1
      ? "测试失败"
      : result.ok === true
        ? tool === "node_test"
          ? "定向测试通过（不代表完整验收）"
          : "观察成功"
        : result.ok === false
          ? "工具失败"
          : "已记录（状态未知）";
  const path = text(result.path) || text(request.path);
  const directory = text(request.directory) || text(result.directory);
  const testPath = text(request.testPath) || text(result.testPath);
  const paths =
    tool === "node_test"
      ? [directory && testPath ? `${directory}/${testPath}` : testPath || directory]
      : [path || directory];
  let summary = blocked;
  let output = "";
  let outputLabel = "查看观察明细";
  if (tool === "read_file") {
    output = text(result.text);
    // Older saved observations may use unnumbered content instead of text.
    if (!output && typeof result.content === "string") {
      const offset = number(result.offset) ?? number(request.offset) ?? 1;
      output = result.content
        .split(/\r?\n/)
        .map((line, index) => `${offset + index}: ${line}`)
        .join("\n");
    }
    summary ||=
      number(result.linesReturned) !== undefined
        ? `已读取 ${result.linesReturned} 行`
        : output
          ? "已读取文件内容"
          : "未返回文件内容";
    outputLabel = "查看带行号的文件内容";
  } else if (tool === "node_test") {
    output = text(result.output).replace(/\x1b\[[0-9;]*m/g, "");
    summary ||= `退出码：${exitCode ?? "未知"}${number(result.durationMs) !== undefined ? ` · 耗时 ${result.durationMs} ms` : ""}`;
    outputLabel = "查看测试输出";
  } else if (tool === "list_files") {
    const entries = Array.isArray(result.entries)
      ? result.entries.map(record).filter((entry) => entry !== null)
      : [];
    output = entries
      .map((entry) => `${text(entry.path)}${entry.type === "directory" ? "/" : ""}`)
      .filter(Boolean)
      .join("\n");
    summary ||= `返回 ${entries.length} 个文件/目录`;
    outputLabel = "查看文件列表";
  } else if (tool === "search_text") {
    const hits = Array.isArray(result.hits)
      ? result.hits.map(record).filter((hit) => hit !== null)
      : [];
    output = hits
      .map((hit) => `${text(hit.path)}:${number(hit.line) ?? "?"}: ${text(hit.text)}`)
      .join("\n");
    summary ||= `搜索「${text(request.query)}」· ${hits.length} 处匹配`;
    outputLabel = "查看带行号的搜索结果";
  }
  return {
    kind: "observation",
    heading: `${TOOLS[tool]} · 观察 #${value.id}`,
    status,
    hypothesis: value.hypothesis,
    paths: paths.filter(Boolean),
    summary: short(summary),
    output: output || (blocked.length > 240 ? blocked : undefined),
    outputLabel,
    truncated: result.truncated === true,
  };
}

const PRE_CLASS =
  "mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-100 px-2.5 py-2 font-mono text-[11px] leading-relaxed dark:bg-zinc-900/60";

export function InvestigationDetail({ detail }: { detail: string }) {
  const display = parseInvestigationDetail(detail);
  const jsonLike = /^[\s]*[\[{]/.test(detail);
  if (!display && !jsonLike) {
    return <pre className={PRE_CLASS}>{detail}</pre>;
  }
  return (
    <div className="mt-1 rounded-lg bg-zinc-50 px-2.5 py-2 text-xs leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300">
      {display ? (
        <>
          <p className="break-words font-medium">{display.heading}</p>
          <p className="mt-1 break-words">状态：{display.status}</p>
          {display.hypothesis ? (
            <p className="mt-1 whitespace-pre-wrap break-words">假设：{display.hypothesis}</p>
          ) : null}
          {display.paths.length ? (
            <ul className="mt-1 space-y-1" aria-label="调查路径">
              {display.paths.map((path, index) => (
                <li key={index} className="break-all font-mono">
                  路径：{path}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 break-words">{display.summary}</p>
          {display.truncated ? (
            <p className="mt-1 text-amber-600 dark:text-amber-400">
              输出已截断，仅显示部分观察；不能视为完整证据。
            </p>
          ) : null}
          {display.output ? (
            <details className="mt-2">
              <summary className="cursor-pointer font-medium">{display.outputLabel}</summary>
              <pre className={PRE_CLASS}>{display.output}</pre>
            </details>
          ) : null}
        </>
      ) : (
        <p>调查记录格式无法识别，请展开调试数据查看原始记录。</p>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-zinc-500">原始 JSON（调试）</summary>
        <pre className={PRE_CLASS}>{detail}</pre>
      </details>
    </div>
  );
}
