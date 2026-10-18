import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  env: vi.fn(),
  model: vi.fn(),
  select: vi.fn(),
}));
vi.mock("ai", () => ({ streamText: mocks.generate }));
vi.mock("@/server/ai/env", () => ({ getAiEnv: mocks.env }));
vi.mock("@/server/ai/provider", () => ({
  getChatModel: mocks.model,
  resolveProviderSelection: mocks.select,
  resolveProviderBaseURL: () => "https://api.deepseek.com/v1",
}));
import {
  generateObjectCompat,
  AiRequestTimeoutError,
  AiOutputFormatError,
  CompatGenerateError,
  type AiRequestEvent,
} from "@/server/ai/compat";

const options = () => ({
  system: "private prompt",
  prompt: "private content",
  schema: z.object({ value: z.string() }),
  schemaName: "Test",
  signal: new AbortController().signal,
});
const result = (text = '{"value":"ok"}', finishReason = "stop") => ({
  fullStream: (async function* () {
    yield { type: "reasoning-delta", text: "private reasoning" };
    yield { type: "text-delta", text };
    yield { type: "finish", finishReason };
  })(),
  finishReason: Promise.resolve(finishReason),
  usage: Promise.resolve({
    inputTokens: 12,
    outputTokens: 34,
    outputTokenDetails: { reasoningTokens: 10 },
  }),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.mockReturnValue({
    AI_PROVIDER: "deepseek",
    AI_DEFAULT_MODEL: "resolved-model",
    DEEPSEEK_API_KEY: "secret-key",
  });
  mocks.select.mockReturnValue({ provider: "deepseek", model: "resolved-model" });
  mocks.model.mockReturnValue({ modelId: "resolved-model" });
  mocks.generate.mockReturnValue(result());
});
afterEach(() => vi.restoreAllMocks());

describe("single-request compat without artificial platform caps", () => {
  it("throttles progress to one second and emits only counts and safe metrics", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const streamed = result();
    streamed.fullStream = (async function* () {
      now = 500;
      yield { type: "reasoning-delta", text: "private reasoning" };
      now = 1000;
      yield { type: "text-delta", text: '{"value":' };
      now = 1200;
      yield { type: "text-delta", text: '"ok"}' };
      yield { type: "finish", finishReason: "stop" };
    })();
    mocks.generate.mockReturnValue(streamed);
    const events: AiRequestEvent[] = [];
    await generateObjectCompat({
      ...options(),
      onRequestEvent: (event) => {
        events.push(event);
      },
    });
    expect(events.map((event) => event.type)).toEqual(["started", "progress", "completed"]);
    expect(events[1]).toMatchObject({
      durationMs: 500,
      firstResponseMs: 500,
      textChars: 0,
      reasoningChars: 17,
    });
    expect(events[2]).toMatchObject({ inputTokens: 12, outputTokens: 34, reasoningTokens: 10 });
    expect(JSON.stringify(events)).not.toMatch(/private|secret/);
  });
  it.each(["error-event", "missing-finish", "error-finish"])(
    "rejects incomplete streams even with valid JSON (%s)",
    async (kind) => {
      mocks.generate.mockReturnValue({
        fullStream: (async function* () {
          yield { type: "text-delta", text: '{"value":"ok"}' };
          if (kind === "error-event") yield { type: "error", error: new Error("private secret") };
          if (kind === "error-finish") yield { type: "finish", finishReason: "error" };
        })(),
        finishReason: Promise.resolve("error"),
        usage: Promise.resolve({}),
      });
      await expect(generateObjectCompat(options())).rejects.toMatchObject({
        name: "AiRequestError",
      });
      expect(mocks.generate).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects invalid usage metrics rather than persisting upstream values", async () => {
    mocks.generate.mockReturnValue({
      ...result(),
      usage: Promise.resolve({
        inputTokens: Infinity,
        outputTokens: -1,
        outputTokenDetails: { reasoningTokens: "private" },
      }),
    });
    const events: AiRequestEvent[] = [];
    await generateObjectCompat({
      ...options(),
      onRequestEvent: (event) => {
        events.push(event);
      },
    });
    expect(events.at(-1)).toMatchObject({
      inputTokens: undefined,
      outputTokens: undefined,
      reasoningTokens: undefined,
    });
  });
  it("omits maxOutputTokens by default and sets no timer", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const input = options();
    const events: AiRequestEvent[] = [];
    await generateObjectCompat({
      ...input,
      onRequestEvent: (event) => {
        events.push(event);
      },
    });
    const request = mocks.generate.mock.calls[0][0];
    expect(request).not.toHaveProperty("maxOutputTokens");
    expect(request).toMatchObject({ maxRetries: 0, abortSignal: input.signal });
    expect(events[0]).not.toHaveProperty("requestedBudget");
    expect(timeout).not.toHaveBeenCalled();
  });
  it.each([100, 4_000, 65_536, 1_000_000])(
    "does not clamp explicit caller allowance %s",
    async (maxOutputTokens) => {
      await generateObjectCompat({ ...options(), maxOutputTokens });
      expect(mocks.generate.mock.calls[0][0].maxOutputTokens).toBe(maxOutputTokens);
    },
  );
  it("omits non-finite caller values rather than forcing a default cap", async () => {
    await generateObjectCompat({ ...options(), maxOutputTokens: NaN });
    expect(mocks.generate.mock.calls[0][0]).not.toHaveProperty("maxOutputTokens");
  });
  it("reports upstream truncation with exact evidence and never repeats the request", async () => {
    const events: AiRequestEvent[] = [];
    mocks.generate.mockReturnValue(result('{"value":', "length"));
    await expect(
      generateObjectCompat({
        ...options(),
        onRequestEvent: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toThrow(/finishReason=length.*9 个文本字符.*平台未设置输出额度/);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(events.map((event) => [event.type, event.attempt])).toEqual([
      ["started", 1],
      ["progress", 1],
      ["failed", 1],
    ]);
    expect(events.at(-1)).toMatchObject({ errorKind: "invalid-json", finishReason: "length" });
    expect(JSON.stringify(events)).not.toMatch(/private|secret-key|DEEPSEEK_API_KEY/);
  });
  it("fails malformed JSON once without leaking generated text", async () => {
    mocks.generate.mockReturnValue(result("private upstream secret-key"));
    await expect(generateObjectCompat(options())).rejects.toThrow(/JSON.*未自动重试/);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['{"value":', "stop", "json"],
    ['{"value":123}', "stop", "schema"],
    ['{"value":"complete"}', "length", "length"],
    ['{"value":"one"}\n{"value":"two"}', "stop", "json"],
  ])("throws typed structured failures (%s, %s)", async (text, finishReason, kind) => {
    mocks.generate.mockReturnValue(result(text, finishReason));
    try {
      await generateObjectCompat(options());
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AiOutputFormatError);
      expect(error).toBeInstanceOf(CompatGenerateError);
      expect(error).toMatchObject({ name: "AiOutputFormatError", kind });
    }
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("preserves a large normal-stop output with embedded fences and selects schema-valid roots", async () => {
    const value = 'quoted " braces {} ```json\\n```\\path\n'.repeat(4_000);
    const text = `{}\n\`\`\`json\n${JSON.stringify({ value })}\n\`\`\``;
    expect(text.length).toBeGreaterThan(100_000);
    mocks.generate.mockReturnValue(result(text));
    await expect(generateObjectCompat(options())).resolves.toEqual({ value });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("retains safe transport cause codes without upstream secrets", async () => {
    mocks.generate.mockImplementation(() => {
      throw Object.assign(new TypeError("secret key private url"), {
        cause: { code: "UND_ERR_HEADERS_TIMEOUT", message: "private endpoint" },
      });
    });
    await expect(generateObjectCompat(options())).rejects.toThrow("UND_ERR_HEADERS_TIMEOUT");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("distinguishes schema failure from missing JSON without leaking values", async () => {
    mocks.generate.mockReturnValue(result('{"value":123}'));
    await expect(generateObjectCompat(options())).rejects.toThrow(
      "JSON Schema 校验失败（1 项问题）",
    );
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("sanitizes network failures and diagnostics without retries", async () => {
    const events: AiRequestEvent[] = [];
    mocks.generate.mockImplementation(() => {
      throw new Error("private upstream https://secret-key@example.com");
    });
    await expect(
      generateObjectCompat({
        ...options(),
        onRequestEvent: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toMatchObject({
      name: "AiRequestError",
      message: "AI 请求失败,请检查服务连接后重试",
    });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(events[1].errorKind).toBe("network");
    expect(JSON.stringify(events)).not.toMatch(/private|secret-key|example.com/);
  });
  it("preserves typed upstream timeouts without manufacturing a timer", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    mocks.generate.mockImplementation(() => {
      throw new DOMException("secret", "TimeoutError");
    });
    await expect(generateObjectCompat(options())).rejects.toBeInstanceOf(AiRequestTimeoutError);
    expect(timeout).not.toHaveBeenCalled();
  });
  it("cancels an uncooperative SDK using the exact parent reason", async () => {
    const controller = new AbortController();
    const reason = new Error("parent cancelled");
    mocks.generate.mockReturnValue({
      fullStream: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
    });
    const pending = generateObjectCompat({ ...options(), signal: controller.signal });
    const assertion = expect(pending).rejects.toBe(reason);
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    controller.abort(reason);
    await assertion;
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("allows parent cancellation while waiting for a started diagnostic callback", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled callback");
    const pending = generateObjectCompat({
      ...options(),
      signal: controller.signal,
      onRequestEvent: (event) => (event.type === "started" ? new Promise(() => {}) : undefined),
    });
    const assertion = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it.each(['```json\n{"value":"ok"}\n```', 'before {"value":"brace } and \\" quote"} after'])(
    "retains fenced and balanced JSON extraction",
    async (text) => {
      mocks.generate.mockReturnValue(result(text));
      await expect(generateObjectCompat(options())).resolves.toHaveProperty("value");
    },
  );
});
