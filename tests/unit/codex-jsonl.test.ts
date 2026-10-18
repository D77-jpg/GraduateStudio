import { describe, expect, it } from "vitest";
import {
  CodexJsonlParser,
  MAX_CODEX_FRAME_BYTES,
  safeCodexDiagnostic,
} from "@/server/agents/adapters/codex-jsonl";
import type { AgentEngineEvent } from "@/server/agents/engine";

function fixture() {
  const events: AgentEngineEvent[] = [];
  const parser = new CodexJsonlParser("test", (event) => events.push(event));
  const frame = (value: unknown) => parser.write(Buffer.from(JSON.stringify(value) + "\n"));
  return { parser, events, frame };
}

describe("safe Codex diagnostics", () => {
  it.each([400, 401, 403, 404, 408, 413, 429, 500, 502, 503, 504])(
    "classifies explicit HTTP %s without copying raw payloads",
    (status) => {
      for (const prefix of [
        `HTTP ${status}`,
        `HTTP/1.1 ${status}`,
        `status code: ${status}`,
        `"status":${status}`,
        `UPSTREAM_HTTP_${status}`,
      ]) {
        const message = safeCodexDiagnostic(`${prefix} raw-private-content Bearer sk-SECRET`);
        expect(message).toContain(`UPSTREAM_HTTP_${status}`);
        expect(message).not.toMatch(/SECRET|raw-private|协议/);
      }
    },
  );
  it.each([
    "api_key=sk-502-secret",
    "request_id=502",
    "502",
    "upstream rejected sk-502-secret",
    "Authorization: Bearer HTTP502secret",
    "api_key='HTTP 502 secret'",
    'api_key="prefix HTTP 502 private-content"',
    'token="prefix status: 429 private-content"',
  ])("does not infer HTTP status from raw secrets or numbers: %s", (raw) => {
    expect(safeCodexDiagnostic(raw)).not.toMatch(/UPSTREAM_HTTP|模型网关|secret/);
  });
  it("prioritizes auth, rate and context over gateway symptoms", () => {
    expect(safeCodexDiagnostic("HTTP 502; HTTP 401")).toContain("authentication");
    expect(safeCodexDiagnostic("HTTP 502; UPSTREAM_HTTP_429")).toContain("rate limit");
    for (const reason of ["context too long", "request too large", "context_length_exceeded"])
      expect(safeCodexDiagnostic(`HTTP 502 ${reason}`)).toMatch(
        /保留模块副本与上下文.*精简上下文.*不要从头/,
      );
  });
  it("uses a fixed generic message for other explicit statuses", () => {
    expect(safeCodexDiagnostic("HTTP 422 private-content")).toBe(
      "模型上游返回 HTTP 错误；已保留进度，请检查服务配置与状态。",
    );
  });
});

describe("bounded Codex JSONL parser", () => {
  it("distinguishes malformed JSON from encoding faults without logging payloads", () => {
    const { parser } = fixture();
    parser.write(Buffer.from('{"type":"agent_message","text":"SECRET_DO_NOT_LOG"\n'));
    expect(parser.failure).toContain("JSONL syntax failed");
    expect(parser.failure).toContain("tail=unclosed");
    expect(parser.failure).not.toContain("SECRET_DO_NOT_LOG");
    const invalid = fixture().parser;
    invalid.write(Buffer.from([0xff, 10]));
    expect(invalid.failure).toContain("UTF-8 decoding failed");
    expect(invalid.failure).not.toContain("JSONL syntax");
  });
  it("decodes multibyte characters at every chunk boundary, CRLF, and final unterminated frame", () => {
    const { parser, events } = fixture();
    const data = Buffer.from(
      '{"type":"message.delta","delta":"你好🌍"}\r\n{"type":"turn.completed"}',
    );
    for (const byte of data) parser.write(Buffer.from([byte]));
    parser.end();
    expect(parser.failure).toBeNull();
    expect(parser.completed).toBe(true);
    expect(parser.lastMessage).toBe("你好🌍");
    expect(events).toHaveLength(1);
  });

  it.each([
    "not-json",
    "null",
    "[]",
    "{}",
    '{"type":3}',
    '{"type":"message.delta","delta":{}}',
    '{"type":"item.completed","item":null}',
  ])("fails closed on malformed frame %s", (line) => {
    const { parser } = fixture();
    parser.write(Buffer.from(line + "\n"));
    expect(parser.failure).toBeTruthy();
    expect(parser.completed).toBe(false);
  });

  it("rejects invalid UTF8 rather than replacing bytes", () => {
    const { parser } = fixture();
    parser.write(
      Buffer.concat([
        Buffer.from('{"type":"message.delta","delta":"'),
        Buffer.from([0xff]),
        Buffer.from('"}\n'),
      ]),
    );
    expect(parser.failure).toContain("UTF-8");
  });

  it("accepts native one-megabyte tool frames while display remains bounded", () => {
    const { parser, events, frame } = fixture();
    frame({
      type: "item.completed",
      item: { type: "command_execution", aggregated_output: "中".repeat(350000), exit_code: 0 },
    });
    frame({ type: "turn.completed" });
    parser.end();
    expect(parser.failure).toBeNull();
    expect(parser.completed).toBe(true);
    expect(JSON.stringify(events).length).toBeLessThan(26000);
  });

  it("bounds unterminated, newline-terminated and total streams", () => {
    for (const suffix of ["", "\n"]) {
      const { parser } = fixture();
      parser.write(Buffer.from("x".repeat(MAX_CODEX_FRAME_BYTES) + suffix));
      if (!suffix) parser.write(Buffer.from("x"));
      expect(parser.failure).toBeTruthy();
    }
    const { parser } = fixture();
    const ignored = Buffer.from(
      JSON.stringify({ type: "future.event", text: "x".repeat(200_000) }) + "\n",
    );
    for (let index = 0; index < 90; index++) parser.write(ignored);
    expect(parser.failure).toContain("stream exceeded");
  });

  it("never forwards reasoning or raw tool payloads, but retains agent output", () => {
    const { parser, events, frame } = fixture();
    for (const type of ["reasoning", "reasoning_summary", "unknown"])
      for (const phase of ["started", "updated", "completed"])
        frame({ type: `item.${phase}`, item: { type, text: "PRIVATE_REASONING" } });
    frame({
      type: "item.started",
      item: {
        type: "command_execution",
        id: "tool",
        command: "echo sk-SECRET",
        reasoning: "PRIVATE_REASONING",
      },
    });
    frame({ type: "item.completed", item: { type: "agent_message", text: "public answer" } });
    frame({ type: "turn.completed" });
    expect(parser.lastMessage).toBe("public answer");
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_REASONING|SECRET/);
    expect(events[0]).toMatchObject({
      type: "tool.started",
      item: { type: "command_execution", id: "tool" },
    });
  });

  it("preserves bounded command diagnostics while redacting credentials and omitting reasoning", () => {
    const { events, frame } = fixture();
    frame({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "pnpm test --token=private123 wb-private456 sk-private789",
        aggregated_output:
          "Authorization: Bearer private111\nAPI_KEY=private222\npassword='private333'\nghp_private444\nhttps://user:private555@example.com\n" +
          "x".repeat(5000),
        exit_code: 2,
        reasoning: "PRIVATE_REASONING",
        summary: "PRIVATE_SUMMARY",
        extra: { secret: "PRIVATE_NESTED" },
      },
    });
    expect(events[0]).toMatchObject({
      type: "tool.completed",
      item: {
        command: "pnpm test --token=[REDACTED] [REDACTED] [REDACTED]",
        exit_code: 2,
      },
    });
    const item = (events[0] as Extract<AgentEngineEvent, { type: "tool.completed" }>)
      .item as Record<string, unknown>;
    expect(String(item.aggregated_output)).toHaveLength(4000);
    expect(JSON.stringify(events)).not.toMatch(/private\d+|PRIVATE_/);
  });

  it("allowlists bounded file-change path and kind metadata only", () => {
    const { events, frame } = fixture();
    frame({
      type: "item.completed",
      item: {
        type: "file_change",
        changes: [
          {
            path: "src/example.ts",
            kind: "update",
            diff: "PRIVATE_DIFF",
            reasoning: "PRIVATE_REASONING",
          },
          { path: "bad", kind: "other" },
          { path: 42, kind: "add" },
          ...Array.from({ length: 150 }, () => ({ path: "x".repeat(1500), kind: "add" })),
        ],
      },
    });
    const item = (events[0] as Extract<AgentEngineEvent, { type: "tool.completed" }>).item as {
      changes: Array<{ path: string; kind: string }>;
    };
    expect(item.changes).toHaveLength(98);
    expect(item.changes[0]).toEqual({ path: "src/example.ts", kind: "update" });
    expect(item.changes[1].path).toHaveLength(1024);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
  });

  it("allows native reconnect notices without treating retry as terminal success", () => {
    const { parser, events, frame } = fixture();
    frame({
      type: "error",
      message: "Reconnecting... 1/5 (stream disconnected before completion: sk-SECRET)",
    });
    expect(parser.failure).toBeNull();
    expect(parser.completed).toBe(false);
    expect(events.at(-1)?.type).toBe("connection.retrying");
    frame({ type: "error", will_retry: true, message: "network sk-SECRET" });
    frame({ type: "item.completed", item: { type: "agent_message", text: "恢复完成" } });
    frame({ type: "turn.completed" });
    parser.end();
    expect(parser.failure).toBeNull();
    expect(parser.completed).toBe(true);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });
  it("still rejects terminal failure after reconnect exhaustion", () => {
    const { parser, frame } = fixture();
    frame({ type: "error", message: "Reconnecting... 1/5" });
    frame({ type: "turn.failed", error: { message: "connection failed" } });
    expect(parser.failure).toBeTruthy();
    expect(parser.completed).toBe(false);
  });
  it("requires terminal completion and rejects events after it", () => {
    const { parser, frame } = fixture();
    frame({ type: "turn.completed" });
    frame({ type: "message.delta", delta: "too late" });
    expect(parser.failure).toContain("after terminal");
    expect(parser.lastMessage).toBe("");
  });

  it("bounds retained messages and sanitizes terminal errors", () => {
    const { parser, events, frame } = fixture();
    frame({ type: "message.delta", delta: "x".repeat(30_000) });
    frame({ type: "turn.failed", error: { message: "HTTP 401 Bearer sk-PRIVATE_SECRET" } });
    expect(parser.lastMessage).toHaveLength(24_000);
    expect(parser.failure).toContain("authentication");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_SECRET");
  });
});
