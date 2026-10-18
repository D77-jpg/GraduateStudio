import { StringDecoder } from "node:string_decoder";

export const ACCEPTANCE_EVIDENCE_BYTE_LIMIT = 1024 * 1024;
export const ACCEPTANCE_EVIDENCE_LINE_LIMIT = 4096;
export const ACCEPTANCE_EVIDENCE_INCOMPLETE_MARKER =
  "[失败证据超过安全上限，收集不完整；不能据此声称已定位全部失败]";
export const MYSQL_ENVIRONMENT_BLOCKED_REASON =
  "真实 MySQL 集成测试环境不可用；先配置/启动测试数据库，不能用代码重写或跳过测试替代。";

type Channel = "stdout" | "stderr";
type Section = "node" | "tap" | "vitest" | undefined;
interface StreamState {
  decoder: StringDecoder;
  pending: string;
  droppingLine: boolean;
  section: Section;
  environmentWindow: string;
}
export interface AcceptanceEvidenceResult {
  failureEvidence?: string;
  failureEvidenceIncomplete?: boolean;
  environmentBlockedReason?: string;
}

/** Text is collected as evidence, never interpreted as instructions or commands. */
export class AcceptanceEvidenceCollector {
  private streams: Record<Channel, StreamState> = {
    stdout: this.newStream(),
    stderr: this.newStream(),
  };
  private lines: string[] = [];
  private bytes = 0;
  private incomplete = false;
  private environmentBlockedReason?: string;

  private newStream(): StreamState {
    return {
      decoder: new StringDecoder("utf8"),
      pending: "",
      droppingLine: false,
      section: undefined,
      environmentWindow: "",
    };
  }

  /** Separate decoders and line buffers prevent interleaved pipes from corrupting UTF-8/lines. */
  write(channel: Channel, chunk: Buffer): string {
    const text = this.streams[channel].decoder.write(chunk);
    this.consume(this.streams[channel], text);
    return text;
  }

  finish(): AcceptanceEvidenceResult {
    for (const state of Object.values(this.streams)) {
      this.consume(state, state.decoder.end());
      if (state.pending && !state.droppingLine) this.line(state, state.pending);
      state.pending = "";
    }
    const evidence = this.lines.join("\n");
    return {
      ...(evidence || this.incomplete
        ? {
            failureEvidence: this.incomplete
              ? `${evidence}${evidence ? "\n" : ""}${ACCEPTANCE_EVIDENCE_INCOMPLETE_MARKER}`
              : evidence,
          }
        : {}),
      ...(this.incomplete ? { failureEvidenceIncomplete: true } : {}),
      ...(this.environmentBlockedReason
        ? { environmentBlockedReason: this.environmentBlockedReason }
        : {}),
    };
  }

  private consume(state: StreamState, text: string): void {
    // Inspect all incoming text, not the bounded head/tail log. Only explicit MySQL
    // connection errors are blockers; an assertion mentioning a DB is not enough.
    // Split chunks into bounded windows so a single large chunk cannot bypass memory bounds.
    for (let i = 0; i < text.length; i += 2048) {
      state.environmentWindow = (state.environmentWindow + text.slice(i, i + 2048)).slice(-8192);
      if (
        /(?:集成测试无法连接 MySQL|无法连接 MySQL 测试库)[^\r\n]*(?:ENOTFOUND|ECONNREFUSED|ETIMEDOUT|Access denied for user|ER_(?:DB)?ACCESS_DENIED_ERROR|Connection lost: The server closed the connection)/i.test(
          state.environmentWindow,
        ) ||
        /(?:getaddrinfo\s+ENOTFOUND|connect\s+(?:ECONNREFUSED|ETIMEDOUT))[^\r\n]*(?:mysql|\bdb\b|:3306\b)/i.test(
          state.environmentWindow,
        )
      ) {
        this.environmentBlockedReason = MYSQL_ENVIRONMENT_BLOCKED_REASON;
      }
    }
    for (const part of text.split(/(?<=\n)/)) {
      const ended = part.endsWith("\n");
      if (!state.droppingLine) {
        state.pending += part;
        if (Buffer.byteLength(state.pending, "utf8") > ACCEPTANCE_EVIDENCE_BYTE_LIMIT) {
          if (state.section || this.startsSection(state.pending)) this.incomplete = true;
          state.pending = "";
          state.droppingLine = true;
        }
      }
      if (ended) {
        if (!state.droppingLine) this.line(state, state.pending.replace(/\r?\n$/, ""));
        state.pending = "";
        state.droppingLine = false;
      }
    }
  }

  private startsSection(line: string): Section {
    if (/^\s*test at\s+.+:\d+(?::\d+)?\s*$/.test(line)) return "node";
    if (/^\s*not ok\b/.test(line)) return "tap";
    if (/^\s*FAIL\s+\S/.test(line)) return "vitest";
    return undefined;
  }

  private line(state: StreamState, raw: string): void {
    const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const start = this.startsSection(line);
    if (start) state.section = start;
    else if (
      (state.section === "tap" &&
        /^\s*(?:ok\b|# Subtest:|1\.\.\d+|# (?:tests|pass|fail)\s)/.test(line)) ||
      (state.section === "vitest" &&
        /^\s*(?:[─━⎯-]{3,}|Test Files\s|Tests\s|Duration\s|Start at\s)/.test(line)) ||
      (state.section === "node" && /^\s*(?:ℹ|✔|# (?:tests|pass|fail)\s)/.test(line))
    ) {
      state.section = undefined;
    }
    if (!state.section) return;
    // Vitest progress/status updates are not failure detail, even when interleaved.
    if (
      state.section === "vitest" &&
      /^\s*(?:[✓✔]|❯\s+.*\(\d+\s+tests?\b|stdout\s*\||stderr\s*\|)/.test(line)
    )
      return;
    const size = Buffer.byteLength(line, "utf8") + (this.lines.length ? 1 : 0);
    // Reserve marker space so even overflow results stay inside the byte budget.
    const budget =
      ACCEPTANCE_EVIDENCE_BYTE_LIMIT -
      Buffer.byteLength(ACCEPTANCE_EVIDENCE_INCOMPLETE_MARKER, "utf8") -
      1;
    if (this.lines.length >= ACCEPTANCE_EVIDENCE_LINE_LIMIT - 1 || this.bytes + size > budget) {
      this.incomplete = true;
      return;
    }
    this.lines.push(line);
    this.bytes += size;
    if (state.section === "tap" && /^\s*\.\.\.\s*$/.test(line)) state.section = undefined;
  }
}
