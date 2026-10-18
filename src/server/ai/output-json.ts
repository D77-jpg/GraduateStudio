import { z } from "zod";
import { summarizeSchemaIssues } from "./schema-diagnostics";

export class CompatGenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompatGenerateError";
  }
}

/** Only allowlisted diagnostics are retained; never attach the source or parser error. */
export class AiOutputFormatError extends CompatGenerateError {
  constructor(
    public readonly kind: "json" | "schema" | "length",
    message: string,
  ) {
    super(message);
    this.name = "AiOutputFormatError";
  }
}

function parseLocation(error: unknown): string {
  if (!(error instanceof SyntaxError)) return "";
  // V8 messages can contain source snippets. Extract numbers only, never the message itself.
  const offset = /\bposition (\d+)\b/.exec(error.message)?.[1];
  const location = /\bline (\d+) column (\d+)\b/.exec(error.message);
  return [
    offset === undefined ? "" : `解析偏移 ${offset}`,
    location ? `行 ${location[1]}、列 ${location[2]}` : "",
  ]
    .filter(Boolean)
    .join("，");
}

/**
 * A single forward, string-aware scan. Only OUTER objects become candidates;
 * nested objects (including objects inside arrays) are never promoted to roots.
 * Recovery is limited to explicit external fences, or a line object after a
 * clearly non-JSON prose brace. Candidate bytes are sliced, never repaired.
 */
function scanObjects(source: string, visit: (start: number, end: number) => void) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let proseBrace = false;
  let lineBoundary = true;
  let roots = 0;
  let abandonedJsonRoot = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      if (ch === "\n") lineBoundary = true;
      else if (ch !== " " && ch !== "\t" && ch !== "\r") lineBoundary = false;
      continue;
    }
    // Fences are recognized only at an external line boundary, never within content strings.
    if (lineBoundary && ch === "`" && source.startsWith("```", i)) {
      let end = i + 3;
      while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end++;
      const label = source.slice(i + 3, end).trim();
      if (label === "json" || label === "") {
        if (depth > 0 && !proseBrace) abandonedJsonRoot = true;
        start = -1;
        depth = 0;
        proseBrace = false;
        i = end - 1;
        lineBoundary = false;
        continue;
      }
    }
    if (ch === "{" && lineBoundary && proseBrace) {
      start = -1;
      depth = 0;
      proseBrace = false;
    }
    if (depth === 0 && (ch === "{" || ch === "[")) {
      start = ch === "{" ? i : -1;
      roots++;
      if (ch === "{") {
        let next = i + 1;
        while (next < source.length && /\s/.test(source[next])) next++;
        proseBrace = next < source.length && source[next] !== '"' && !"{}[]".includes(source[next]);
      }
      depth = 1;
    } else if (depth > 0) {
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          if (start >= 0) visit(start, i + 1);
          start = -1;
          proseBrace = false;
        }
      }
    }
    if (ch === "\n") lineBoundary = true;
    else if (ch !== " " && ch !== "\t" && ch !== "\r") lineBoundary = false;
  }
  return {
    roots,
    missingClose: depth > 0,
    unterminatedString: inString,
    incompleteJsonRoot: abandonedJsonRoot || (depth > 0 && !proseBrace),
  };
}

/** Select the unique complete root matching the caller's schema, without content mutation. */
export function extractOutputJson<T>(source: string, schema: z.ZodType<T>): T {
  let candidateCount = 0;
  let parsedCount = 0;
  let validCount = 0;
  let selected: T | undefined;
  let schemaError: z.ZodError | undefined;
  let location = "";
  const scan = scanObjects(source, (start, end) => {
    candidateCount++;
    let value: unknown;
    try {
      value = JSON.parse(source.slice(start, end));
      parsedCount++;
    } catch (error) {
      if (!location) location = parseLocation(error);
      return;
    }
    const checked = schema.safeParse(value);
    if (checked.success) {
      validCount++;
      if (validCount === 1) selected = checked.data;
    } else if (!schemaError) schemaError = checked.error;
  });
  const counts = `收到 ${source.length} 个文本字符，根块 ${scan.roots}，完整候选 ${candidateCount}，可解析 ${parsedCount}，匹配 ${validCount}，缺少闭合=${scan.missingClose ? 1 : 0}，字符串未闭合=${scan.unterminatedString ? 1 : 0}`;
  if (validCount > 1) {
    throw new AiOutputFormatError(
      "json",
      `AI 输出包含多个符合 JSON Schema 的完整根对象，存在歧义，未任意选择（${counts}）；未自动重试。`,
    );
  }
  if (validCount === 1 && scan.incompleteJsonRoot) {
    throw new AiOutputFormatError(
      "json",
      `AI 输出还包含未闭合的 JSON 根块，不能安全忽略可能遗漏的变更（${counts}）；未自动重试。`,
    );
  }
  if (validCount === 1) return selected as T;
  if (schemaError) {
    throw new AiOutputFormatError(
      "schema",
      `AI 输出 JSON Schema 校验失败（${schemaError.issues.length} 项问题）：${summarizeSchemaIssues(schemaError)}（${counts}）；未自动重试。`,
    );
  }
  throw new AiOutputFormatError(
    "json",
    `AI 输出未找到可解析的完整 JSON 对象（${counts}${location ? `，${location}` : ""}）；未自动重试。`,
  );
}
