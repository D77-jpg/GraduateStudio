import type { AgentEngineEvent } from "../engine";

// Native command_execution events include up to ~1MiB of aggregated tool output.
// Bound whole frames separately from the 4KB redacted display projection.
export const MAX_CODEX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_LAST_MESSAGE = 24_000;

/** Never forward raw stderr/error payloads: they may contain credentials or reasoning. */
export function safeCodexDiagnostic(value: string): string {
  // A bare number may be part of a credential, URL or request id, not an HTTP status.
  const withoutQuotedSecrets = value.replace(
    /((?:[\w-]*(?:api[_-]?key|token|secret|password|passwd|credential)[\w-]*)["']?\s*[:=]\s*)(["'])(.*?)\2/gi,
    "$1[REDACTED]",
  );
  const text = safeToolText(withoutQuotedSecrets, withoutQuotedSecrets.length);
  const statuses = [
    ...text.matchAll(
      /\b(?:UPSTREAM_HTTP_|HTTP(?:\/\d(?:\.\d)?)?\s+(?:(?:error|status)(?:\s+code)?\s*[:=]?\s*)?|status(?:[_ -]code)?["']?\s*[:=]?\s+|status(?:[_ -]code)?["']?\s*[:=]\s*)([1-5]\d{2})\b/gi,
    ),
  ].map((match) => match[1]);
  const has = (code: string) => statuses.includes(code);
  const auth =
    "Codex authentication failed (refresh token revoked or credentials expired); sign in again.";
  const rate = "Codex rate limit or quota exceeded; check account limits and retry later.";
  if (
    has("401") ||
    has("403") ||
    /revoked|refresh.token|unauthori[sz]ed|authentication/i.test(text)
  )
    return has("403")
      ? `${auth} (UPSTREAM_HTTP_403)`
      : has("401")
        ? `${auth} (UPSTREAM_HTTP_401)`
        : auth;
  if (has("429") || /rate.limit|quota/i.test(text))
    return has("429") ? `${rate} (UPSTREAM_HTTP_429)` : rate;
  if (
    has("413") ||
    /context[_ -]?(?:length|window|too long)|context.{0,40}(?:exceed|too (?:long|large))|request (?:is )?too large|too many tokens|maximum context/i.test(
      text,
    )
  )
    return `模型请求上下文过长或请求体过大${has("413") ? "（UPSTREAM_HTTP_413）" : ""}；已保留模块副本与上下文，请精简上下文后继续，不要从头生成。`;
  if (/panicked at|thread .*panicked|fatal runtime error|memory allocation .*failed/i.test(text))
    return "Codex native process crashed; its output may be truncated. Task workspace preserved.";
  if (/invalid transport|Error loading config.toml/i.test(text))
    return "Codex configuration is invalid (provider/MCP transport).";
  // Messages are fixed per status: never infer a protocol mismatch from a gateway error.
  const httpMessages: Record<string, string> = {
    "400": "模型上游拒绝请求参数（UPSTREAM_HTTP_400）；请检查模型与请求配置。",
    "404": "模型上游接口或模型不存在（UPSTREAM_HTTP_404）；请检查服务地址与模型配置。",
    "408": "模型上游请求超时（UPSTREAM_HTTP_408）；已保留进度，请稍后继续。",
    "500": "模型上游内部错误（UPSTREAM_HTTP_500）；已保留进度，请稍后继续。",
    "502": "模型网关返回错误（UPSTREAM_HTTP_502）；已保留进度，请检查上游服务状态后继续。",
    "503": "模型上游暂时不可用（UPSTREAM_HTTP_503）；已保留进度，请稍后继续。",
    "504": "模型网关等待上游超时（UPSTREAM_HTTP_504）；已保留进度，请稍后继续。",
  };
  for (const status of statuses) {
    if (httpMessages[status]) return httpMessages[status];
  }
  if (statuses.length) return "模型上游返回 HTTP 错误；已保留进度，请检查服务配置与状态。";
  if (/ECONN|ENOTFOUND|network|connection|TLS|certificate/i.test(text))
    return "Codex connection failed; check network access and retry.";
  return "Codex reported an error; check CLI configuration and authentication.";
}

/** Redact before truncating so a secret crossing the display limit cannot leak a prefix. */
function safeToolText(value: string, limit = 4000): string {
  return value
    .replace(/\b(?:sk|wb|ghp|gho|ghu|ghs|github_pat)-[\w-]+/gi, "[REDACTED]")
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[\w-]+/gi, "[REDACTED]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+\/_=.:-]+/gi, "[REDACTED]")
    .replace(/((?:authorization|proxy-authorization)\s*[\"']?\s*[:=]\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(
      /((?:[\w-]*(?:api[_-]?key|token|secret|password|passwd|credential)[\w-]*)[\"']?\s*(?:[:=]|\s)\s*)[\"']?[^\s\"';&,}]+[\"']?/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, limit);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Byte-bounded JSONL parser. Unknown event types are ignored, never persisted. */
export class CodexJsonlParser {
  private pending = Buffer.alloc(0);
  private bytes = 0;
  private ended = false;
  private frames = 0;
  completed = false;
  failure: string | null = null;
  threadId: string | null = null;
  lastMessage = "";

  constructor(
    private readonly runId: string,
    private readonly emit: (event: AgentEngineEvent) => void,
  ) {}

  private fail(message: string): void {
    this.failure ??= message;
    this.pending = Buffer.alloc(0);
  }

  write(chunk: Buffer): void {
    if (this.ended || this.failure) return;
    this.bytes += chunk.length;
    if (this.bytes > MAX_STREAM_BYTES)
      return this.fail("Codex JSONL stream exceeded its byte limit.");
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      if (this.pending.length + index - start > MAX_CODEX_FRAME_BYTES)
        return this.fail("Codex JSONL frame exceeded its byte limit.");
      const line = Buffer.concat([this.pending, chunk.subarray(start, index)]);
      this.pending = Buffer.alloc(0);
      this.frame(line);
      if (this.failure) return;
      start = index + 1;
    }
    if (this.pending.length + chunk.length - start > MAX_CODEX_FRAME_BYTES)
      return this.fail("Codex JSONL frame exceeded its byte limit.");
    this.pending = Buffer.concat([this.pending, chunk.subarray(start)]);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.failure && this.pending.length) this.frame(this.pending);
    this.pending = Buffer.alloc(0);
  }

  private message(text: string): void {
    this.lastMessage = (this.lastMessage + text).slice(-MAX_LAST_MESSAGE);
    this.emit({ type: "message.delta", runId: this.runId, text });
  }

  private frame(bytes: Buffer): void {
    let raw: unknown;
    const frame = ++this.frames;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    } catch {
      return this.fail(
        `Codex UTF-8 decoding failed (frame=${frame}, bytes=${bytes.length}); output not accepted.`,
      );
    }
    if (!text) return;
    try {
      raw = JSON.parse(text);
    } catch {
      // Structural diagnostics only: never persist raw output, snippets, tool arguments or secrets.
      const shape = text.startsWith("{")
        ? "object-like"
        : text.startsWith("[")
          ? "array-like"
          : "non-json";
      const tail = text.endsWith("}") || text.endsWith("]") ? "closed" : "unclosed";
      return this.fail(
        `Codex JSONL syntax failed (frame=${frame}, bytes=${bytes.length}, shape=${shape}, tail=${tail}); output not accepted.`,
      );
    }
    if (!record(raw) || typeof raw.type !== "string" || !raw.type)
      return this.fail("Codex emitted an invalid event envelope.");
    if (this.completed) return this.fail("Codex emitted an event after terminal turn.completed.");
    const runId = this.runId;
    switch (raw.type) {
      case "thread.started":
        if (typeof raw.thread_id !== "string" || !raw.thread_id || raw.thread_id.length > 256)
          return this.fail("Codex emitted an invalid thread identifier.");
        this.threadId = raw.thread_id;
        this.emit({ type: "thread.started", runId, threadId: raw.thread_id });
        break;
      case "turn.started":
        this.emit({ type: "turn.started", runId });
        break;
      case "turn.completed":
        this.completed = true;
        break;
      case "error":
      case "turn.failed": {
        const message =
          typeof raw.message === "string"
            ? raw.message
            : record(raw.error) && typeof raw.error.message === "string"
              ? raw.error.message
              : "";
        // Native exec emits nonterminal `error` notices while retrying a stream.
        // Do not kill its built-in recovery. Only explicit retry notices qualify;
        // terminal turn.failed and unclassified errors still fail closed.
        if (
          raw.type === "error" &&
          (raw.will_retry === true || /^Reconnecting\.\.\.\s+\d+\/\d+(?:\s|$)/.test(message))
        ) {
          this.emit({
            type: "connection.retrying",
            runId,
            message: "模型连接暂时中断，正在重新连接…",
          });
          break;
        }
        this.failure = safeCodexDiagnostic(message);
        this.emit({ type: "error", runId, message: this.failure });
        break;
      }
      case "message.delta":
      case "agent_message.delta": {
        const delta = raw.delta ?? raw.text;
        if (typeof delta !== "string") return this.fail("Codex emitted an invalid message delta.");
        this.message(delta);
        break;
      }
      case "item.started":
      case "item.updated":
      case "item.completed": {
        if (!record(raw.item) || typeof raw.item.type !== "string")
          return this.fail("Codex emitted an invalid item event.");
        const item = raw.item;
        if (typeof item.type !== "string") return;
        // Reasoning, summaries and arbitrary payloads must never enter the event store.
        if (item.type === "agent_message") {
          if (raw.type === "item.completed") {
            if (typeof item.text !== "string")
              return this.fail("Codex emitted an invalid agent message.");
            this.message(item.text);
          }
          return;
        }
        if (
          ![
            "command_execution",
            "file_change",
            "mcp_tool_call",
            "web_search",
            "todo_list",
          ].includes(item.type)
        )
          return;
        if (raw.type === "item.updated") return;
        const metadata = {
          type: item.type,
          ...(typeof item.id === "string" ? { id: safeToolText(item.id, 256) } : {}),
          ...(typeof item.status === "string" ? { status: safeToolText(item.status, 64) } : {}),
          ...(item.type === "command_execution" && typeof item.command === "string"
            ? { command: safeToolText(item.command) }
            : {}),
          ...(item.type === "command_execution" && typeof item.aggregated_output === "string"
            ? { aggregated_output: safeToolText(item.aggregated_output) }
            : {}),
          ...(typeof item.exit_code === "number" && Number.isSafeInteger(item.exit_code)
            ? { exit_code: item.exit_code }
            : {}),
          ...(item.type === "file_change" && Array.isArray(item.changes)
            ? {
                changes: item.changes.slice(0, 100).flatMap((change: unknown) => {
                  if (
                    !record(change) ||
                    typeof change.path !== "string" ||
                    !["add", "delete", "update"].includes(String(change.kind))
                  )
                    return [];
                  return [{ path: safeToolText(change.path, 1024), kind: change.kind }];
                }),
              }
            : {}),
        };
        this.emit({
          type: raw.type === "item.started" ? "tool.started" : "tool.completed",
          runId,
          item: metadata,
        });
        break;
      }
    }
  }
}
