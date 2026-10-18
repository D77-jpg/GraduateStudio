import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("ai", () => ({ streamText: mocks.stream }));
vi.mock("@/server/ai/env", () => ({ getAiEnv: () => ({}) }));
vi.mock("@/server/ai/provider", () => ({
  getChatModel: () => ({ modelId: "deepseek-flash" }),
  resolveProviderSelection: () => ({ provider: "deepseek", model: "deepseek-flash" }),
  resolveProviderBaseURL: () => "https://api.deepseek.com/v1",
}));
import { generateObjectCompat, type AiRequestEvent } from "@/server/ai/compat";

const options = () => ({
  system: "private prompt",
  prompt: "secret content",
  schema: z.object({ value: z.string() }),
  schemaName: "Retry",
  signal: new AbortController().signal,
});
const httpError = (statusCode: number) =>
  Object.assign(new Error("secret upstream body"), {
    name: "AI_APICallError",
    statusCode,
    responseBody: "secret",
    url: "https://private.test",
  });
const stream = (parts: object[]) => ({
  fullStream: (async function* () {
    for (const part of parts) yield part;
  })(),
  finishReason: Promise.resolve("stop"),
  usage: Promise.resolve({ inputTokens: 12, outputTokens: 8 }),
});
const success = () => stream([{ type: "text-delta", text: '{"value":"ok"}' }, { type: "finish" }]);
const failed = (error: unknown, parts: object[] = []) =>
  stream([...parts, { type: "error", error }]);

beforeEach(() => {
  vi.useFakeTimers();
  mocks.stream.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded pre-output transient retries", () => {
  it.each([502, 503, 504, 429])(
    "recovers from HTTP %s after exactly one second",
    async (status) => {
      const events: AiRequestEvent[] = [];
      const log = vi.spyOn(console, "error");
      mocks.stream.mockReturnValueOnce(failed(httpError(status))).mockReturnValueOnce(success());
      const pending = generateObjectCompat({
        ...options(),
        onRequestEvent: (event) => {
          events.push(event);
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.stream).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(mocks.stream).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ value: "ok" });
      expect(events.map((e) => [e.type, e.attempt])).toEqual([
        ["started", 1],
        ["failed", 1],
        ["started", 2],
        ["progress", 2],
        ["completed", 2],
      ]);
      expect(events[1]).toMatchObject({ textChars: 0, reasoningChars: 0, errorKind: "network" });
      expect(events.at(-1)).toMatchObject({
        inputTokens: 12,
        outputTokens: 8,
        requestedBudget: 393216,
      });
      expect(JSON.stringify(events)).not.toMatch(/secret|private|responseBody/);
      expect(log).not.toHaveBeenCalled();
      for (const [request] of mocks.stream.mock.calls)
        expect(request).toMatchObject({
          maxRetries: 0,
          maxOutputTokens: 393216,
          providerOptions: { openai: { reasoningEffort: "high" } },
        });
    },
  );

  it("bounds repeated failures to three attempts with 1s then 3s backoff", async () => {
    const events: AiRequestEvent[] = [];
    mocks.stream.mockImplementation(() => {
      throw httpError(502);
    });
    const pending = generateObjectCompat({
      ...options(),
      onRequestEvent: (e) => {
        events.push(e);
      },
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AiRequestError" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2999);
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(mocks.stream).toHaveBeenCalledTimes(3);
    expect(events.map((e) => [e.type, e.attempt])).toEqual([
      ["started", 1],
      ["failed", 1],
      ["started", 2],
      ["failed", 2],
      ["started", 3],
      ["failed", 3],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new TypeError("fetch failed"),
    Object.assign(new Error("secret"), { cause: { code: "ECONNRESET" } }),
    Object.assign(new Error("secret"), { cause: { code: "UND_ERR_SOCKET" } }),
    Object.assign(new Error("secret"), { cause: { code: "EAI_AGAIN" } }),
  ])("retries recognizable transport failures without output (%s)", async (error) => {
    mocks.stream.mockReturnValueOnce(failed(error)).mockReturnValueOnce(success());
    const pending = generateObjectCompat(options());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ value: "ok" });
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 500])("does not retry nontransient HTTP %s", async (status) => {
    mocks.stream.mockReturnValue(
      failed(Object.assign(httpError(status), { cause: { code: "ECONNRESET" } })),
    );
    await expect(generateObjectCompat(options())).rejects.toMatchObject({ name: "AiRequestError" });
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["text-delta", "reasoning-delta"])("never duplicates partial %s output", async (type) => {
    const events: AiRequestEvent[] = [];
    mocks.stream.mockReturnValue(failed(httpError(503), [{ type, text: "partial" }]));
    await expect(
      generateObjectCompat({
        ...options(),
        onRequestEvent: (e) => {
          events.push(e);
        },
      }),
    ).rejects.toMatchObject({ name: "AiRequestError" });
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      textChars: type === "text-delta" ? 7 : 0,
      reasoningChars: type === "reasoning-delta" ? 7 : 0,
    });
  });

  it("allows empty deltas but resets per-attempt metrics", async () => {
    const events: AiRequestEvent[] = [];
    mocks.stream
      .mockReturnValueOnce(failed(httpError(502), [{ type: "text-delta", text: "" }]))
      .mockReturnValueOnce(success());
    const pending = generateObjectCompat({
      ...options(),
      onRequestEvent: (e) => {
        events.push(e);
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(events.find((e) => e.type === "started" && e.attempt === 2)).toMatchObject({
      durationMs: 0,
      textChars: 0,
      reasoningChars: 0,
      firstResponseMs: undefined,
      inputTokens: undefined,
    });
  });

  it("does not retry invalid JSON", async () => {
    mocks.stream.mockReturnValue(
      stream([{ type: "text-delta", text: "not JSON" }, { type: "finish" }]),
    );
    await expect(generateObjectCompat(options())).rejects.toMatchObject({
      name: "AiOutputFormatError",
    });
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1000])(
    "cancels during backoff after %s ms with the exact reason",
    async (elapsed) => {
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      mocks.stream.mockImplementation(() => {
        throw httpError(502);
      });
      const pending = generateObjectCompat({ ...options(), signal: controller.signal });
      const assertion = expect(pending).rejects.toBe(reason);
      await vi.advanceTimersByTimeAsync(elapsed);
      controller.abort(reason);
      await assertion;
      expect(mocks.stream).toHaveBeenCalledTimes(elapsed === 0 ? 1 : 2);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10000);
      expect(mocks.stream).toHaveBeenCalledTimes(elapsed === 0 ? 1 : 2);
    },
  );

  it("does not retry an upstream abort without caller cancellation", async () => {
    mocks.stream.mockReturnValue(failed(new DOMException("secret", "AbortError")));
    await expect(generateObjectCompat(options())).rejects.toMatchObject({ name: "AiRequestError" });
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it("does not treat diagnostic callback failures as transport retries", async () => {
    mocks.stream.mockReturnValue(success());
    await expect(
      generateObjectCompat({
        ...options(),
        onRequestEvent: () => {
          throw httpError(502);
        },
      }),
    ).rejects.toMatchObject({ name: "AiRequestError" });
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});
