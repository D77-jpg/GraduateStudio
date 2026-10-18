import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { z } from "zod";
import { generateObjectCompat, type AiRequestEvent } from "@/server/ai/compat";
import { getChatModel } from "@/server/ai/provider";
import { isOfficialDeepSeekFlash } from "@/server/ai/request-policy";

vi.mock("@/server/ai/config-store", () => ({ aiConfigStore: { read: () => undefined } }));

const fakeKey = "fake-wire-test-key";
const env = {
  AI_PROVIDER: "deepseek" as const,
  AI_DEFAULT_MODEL: "deepseek-flash",
  DEEPSEEK_API_KEY: fakeKey,
};
const wire = () => {
  const frames = [
    {
      id: "test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [
        { index: 0, delta: { reasoning_content: "private reasoning" }, finish_reason: null },
      ],
    },
    {
      id: "test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: { content: '{"value":"ok"}' }, finish_reason: null }],
    },
    {
      id: "test",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 34,
        total_tokens: 46,
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    },
  ];
  return new Response(
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("official DeepSeek request policy and actual SDK wire", () => {
  it.each([
    ["https://api.deepseek.com/v1", "deepseek", "deepseek-flash", true],
    ["https://api.deepseek.com", "deepseek", "deepseek-flash", true],
    ["https://api.deepseek.com.evil.test/v1", "deepseek", "deepseek-flash", false],
    ["https://gateway.test/v1", "deepseek", "deepseek-flash", false],
    ["http://api.deepseek.com/v1", "deepseek", "deepseek-flash", false],
    ["https://api.deepseek.com:8443/v1", "deepseek", "deepseek-flash", false],
    ["https://api.deepseek.com/v1", "openai", "deepseek-flash", false],
    ["https://api.deepseek.com/v1", "deepseek", "deepseek-chat", false],
    ["https://api.deepseek.com/v1", "deepseek", "v4.1-flash", false],
  ] as const)("scopes %s %s %s", (baseURL, provider, model, expected) => {
    expect(isOfficialDeepSeekFlash({ provider, model }, baseURL)).toBe(expected);
  });
  it("streams official structured generation with the verified wire fields and safe usage", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv("AI_BASE_URL", "https://api.deepseek.com/v1");
    const fetchMock = vi.fn().mockImplementation(wire);
    vi.stubGlobal("fetch", fetchMock);
    // Environment config store must not contain saved state in unit test runs.
    const events: AiRequestEvent[] = [];
    await expect(
      generateObjectCompat({
        system: "JSON only",
        prompt: "return value",
        schema: z.object({ value: z.string() }),
        schemaName: "Wire",
        signal: new AbortController().signal,
        onRequestEvent: (event) => {
          events.push(event);
        },
      }),
    ).resolves.toEqual({ value: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "deepseek-flash",
      stream: true,
      max_tokens: 393216,
      response_format: { type: "json_object" },
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      requestedBudget: 393216,
      inputTokens: 12,
      outputTokens: 34,
      reasoningTokens: 10,
      reasoningChars: 0,
    });
    expect(JSON.stringify(events)).not.toContain(fakeKey);
    expect(JSON.stringify(events)).not.toContain("private reasoning");
  });
  it.each([
    ["deepseek", "deepseek-flash", "https://gateway.test/v1"],
    ["deepseek", "deepseek-chat", "https://api.deepseek.com/v1"],
    ["openai", "deepseek-flash", "https://api.deepseek.com/v1"],
  ] as const)(
    "does not inject official fields on structured %s %s %s",
    async (provider, model, baseURL) => {
      const fetchMock = vi.fn().mockImplementation(wire);
      vi.stubGlobal("fetch", fetchMock);
      const { streamText } = await import("ai");
      const result = streamText({
        model: getChatModel(
          {
            ...env,
            AI_PROVIDER: provider,
            AI_DEFAULT_MODEL: model,
            AI_BASE_URL: baseURL,
            AI_OPENAI_API_KEY: fakeKey,
          },
          { structuredGeneration: true },
        ),
        prompt: "JSON",
        maxRetries: 0,
        onError: () => {},
      });
      for await (const part of result.fullStream) if (part.type === "error") throw part.error;
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.stream).toBe(true);
      for (const key of ["max_tokens", "response_format", "thinking", "reasoning_effort"])
        expect(body).not.toHaveProperty(key);
    },
  );
  it("preserves explicit short structured budgets instead of overriding them", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv("AI_BASE_URL", "https://api.deepseek.com/v1");
    const fetchMock = vi.fn().mockImplementation(wire);
    vi.stubGlobal("fetch", fetchMock);
    await generateObjectCompat({
      system: "JSON only",
      prompt: "value",
      schema: z.object({ value: z.string() }),
      schemaName: "Wire",
      signal: new AbortController().signal,
      maxOutputTokens: 20,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      max_tokens: 20,
      stream: true,
      response_format: { type: "json_object" },
    });
  });
  it("keeps ordinary short connection tests at 20 with no JSON/thinking injection", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "test",
            object: "chat.completion",
            created: 1,
            model: "deepseek-flash",
            choices: [
              { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await generateText({
      model: getChatModel(env),
      prompt: "ping",
      maxOutputTokens: 20,
      maxRetries: 0,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(20);
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});
