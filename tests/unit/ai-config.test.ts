import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { aiConfigInputSchema, aiConfigStore, createAiConfigStore } from "@/server/ai/config-store";
import { getAiEnv } from "@/server/ai/env";
import { getChatModel } from "@/server/ai/provider";
import {
  canEditAiConfig,
  getPublicAiConfig,
  hasActiveAiTasks,
  resolveAiConfigDraft,
} from "@/server/ai/config-access";
import { testAiConnection } from "@/server/ai/config-test";
import { db } from "@/server/db";
import { generateText } from "ai";

vi.mock("@/server/db", () => ({
  db: { user: { findFirst: vi.fn(), findUnique: vi.fn() }, agentTask: { findFirst: vi.fn() } },
}));
vi.mock("ai", () => ({ generateText: vi.fn() }));
const openai = vi.hoisted(() => vi.fn(() => ({ chat: vi.fn((model: string) => ({ model })) })));
const anthropic = vi.hoisted(() => vi.fn(() => vi.fn((model: string) => ({ model }))));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: openai }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: anthropic }));

const draft = { provider: "deepseek" as const, model: "deepseek-chat", baseURL: "" };
let directory: string;
beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "graduate-ai-"));
  vi.spyOn(aiConfigStore, "readProfiles").mockReturnValue({ activeProfileId: null, profiles: [] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

describe("encrypted store", () => {
  it("roundtrips encrypted configuration, caches safely, resets and loads on restart", () => {
    const path = join(directory, "ai.json");
    const store = createAiConfigStore(path, () => "secret");
    const config = { ...draft, apiKey: "key-private-test" };
    store.save(config);
    expect(readFileSync(path, "utf8")).not.toContain(config.apiKey);
    expect(store.read()).toEqual(config);
    store.read()!.apiKey = "modified";
    expect(store.read()!.apiKey).toBe(config.apiKey);
    expect(createAiConfigStore(path, () => "secret").read()).toEqual(config);
    store.reset();
    expect(store.read()).toBeNull();
  });
  it("retains providers, upserts compatible legacy saves and supports explicit profile lifecycle", () => {
    const path = join(directory, "ai.json");
    const store = createAiConfigStore(path, () => "secret");
    store.save({ ...draft, apiKey: "ds-private" });
    const first = store.readProfiles().profiles[0];
    store.save({ provider: "openai", model: "m", baseURL: "", apiKey: "oa-private" });
    expect(store.readProfiles().profiles).toHaveLength(2);
    store.save({ ...draft, model: "updated" });
    expect(store.read()!.apiKey).toBe("ds-private");
    expect(store.readProfiles().activeProfileId).toBe(first.id);
    store.save(
      { ...draft, apiKey: "another-private" },
      { createNew: true, activate: false, name: "Another" },
    );
    const bundle = store.readProfiles();
    expect(bundle.profiles).toHaveLength(3);
    expect(bundle.activeProfileId).toBe(first.id);
    bundle.profiles[0].apiKey = "mutated";
    expect(store.read()!.apiKey).toBe("ds-private");
    const other = bundle.profiles[2];
    store.activate(other.id);
    expect(store.read()!.apiKey).toBe("another-private");
    store.save({ ...draft, baseURL: "https://changed.test/v1" }, { profileId: other.id });
    expect(store.read()!.apiKey).toBeUndefined();
    store.deleteProfile(other.id);
    expect(store.readProfiles().activeProfileId).toBe(first.id);
    for (const profile of store.readProfiles().profiles) store.deleteProfile(profile.id);
    expect(store.read()).toBeNull();
    expect(store.readProfiles()).toEqual({ profiles: [], activeProfileId: null });
    expect(() => store.activate(other.id)).toThrow("profile_not_found");
    expect(readFileSync(path, "utf8")).not.toContain("private");
  });
  it("migrates encrypted version one automatically without losing its credentials", () => {
    const path = join(directory, "legacy.json");
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update("secret").digest(),
      iv,
    );
    const legacy = { ...draft, apiKey: "legacy-private" };
    const data = Buffer.concat([cipher.update(JSON.stringify(legacy), "utf8"), cipher.final()]);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      }),
    );
    const store = createAiConfigStore(path, () => "secret");
    expect(store.read()).toEqual(legacy);
    const bundle = store.readProfiles();
    expect(bundle.profiles).toHaveLength(1);
    expect(bundle.activeProfileId).toBe(bundle.profiles[0].id);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
    expect(readFileSync(path, "utf8")).not.toContain("legacy-private");
    expect(createAiConfigStore(path, () => "secret").readProfiles()).toEqual(bundle);
  });
  it("invalidates cached profiles when the encryption secret changes", () => {
    let secret = "first";
    const store = createAiConfigStore(join(directory, "ai.json"), () => secret);
    store.save({ ...draft, apiKey: "private" });
    store.readProfiles();
    secret = "second";
    expect(() => store.readProfiles()).toThrow("config_unavailable");
  });
  it("requires a secret and fails closed for tampering/rotation", () => {
    const path = join(directory, "ai.json");
    expect(() => createAiConfigStore(path, () => " ").save(draft)).toThrow("auth_secret_required");
    const store = createAiConfigStore(path, () => "secret");
    store.save(draft);
    expect(() => createAiConfigStore(path, () => "other").read()).toThrow("config_unavailable");
    writeFileSync(path, "broken");
    expect(() => store.read()).toThrow("config_unavailable");
    store.reset();
    expect(store.read()).toBeNull();
  });
});

describe("validation", () => {
  it.each([
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/?key=x",
    "https://example.com/#x",
    "file:///tmp",
    "http://localhost.example.com",
  ])("rejects unsafe endpoint %s", (baseURL) => {
    expect(aiConfigInputSchema.safeParse({ ...draft, baseURL }).success).toBe(false);
  });
  it.each([
    "https://example.com/v1",
    "http://localhost:4000/v1",
    "http://127.0.0.1:4000",
    "http://[::1]:4000",
  ])("accepts endpoint %s", (baseURL) => {
    expect(aiConfigInputSchema.safeParse({ ...draft, baseURL }).success).toBe(true);
  });
  it("rejects unknown provider and long model", () => {
    expect(aiConfigInputSchema.safeParse({ ...draft, provider: "invalid" }).success).toBe(false);
    expect(aiConfigInputSchema.safeParse({ ...draft, model: "x".repeat(161) }).success).toBe(false);
  });
});

describe("runtime/provider integration", () => {
  it("explicit getAiEnv is pure, default overlays saved config", () => {
    const read = vi.spyOn(aiConfigStore, "read").mockReturnValue({ ...draft, apiKey: "saved-ds" });
    expect(getAiEnv({ OPENAI_API_KEY: "env-oa" }).AI_PROVIDER).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(getAiEnv().DEEPSEEK_API_KEY).toBe("saved-ds");
  });
  it.each(["deepseek", "glm", "openrouter"] as const)("uses %s own key, not OpenAI", (provider) => {
    getChatModel(
      getAiEnv({
        AI_PROVIDER: provider,
        OPENAI_API_KEY: "wrong",
        [`${provider.toUpperCase()}_API_KEY`]: "right",
        AI_BASE_URL: "https://gateway.test/v1",
      }),
    );
    expect(openai).toHaveBeenCalledWith({ apiKey: "right", baseURL: "https://gateway.test/v1" });
  });
  it("supports Anthropic custom base URL", () => {
    getChatModel(
      getAiEnv({
        AI_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "right",
        AI_BASE_URL: "https://gateway.test",
      }),
    );
    expect(anthropic).toHaveBeenCalledWith({ apiKey: "right", baseURL: "https://gateway.test" });
  });
  it("blank switching keys retains selected env key, never previous provider key", () => {
    vi.spyOn(aiConfigStore, "read").mockReturnValue({
      provider: "openai",
      model: "m",
      baseURL: "",
      apiKey: "saved-oa",
    });
    vi.stubEnv("DEEPSEEK_API_KEY", "env-ds");
    expect(resolveAiConfigDraft(draft).config.apiKey).toBe("env-ds");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    expect(() => resolveAiConfigDraft(draft)).toThrow("api_key_required");
  });
  it("reuses only the selected profile credentials and requires keys for new or changed endpoints", () => {
    const id = "b6bafbe2-7cca-4c6f-a016-4130b4f34613";
    vi.mocked(aiConfigStore.readProfiles).mockReturnValue({
      activeProfileId: id,
      profiles: [{ ...draft, id, name: "DS", apiKey: "private-saved" }],
    });
    expect(resolveAiConfigDraft({ ...draft, profileId: id }).config.apiKey).toBe("private-saved");
    vi.stubEnv("DEEPSEEK_API_KEY", "private-env");
    expect(() => resolveAiConfigDraft({ ...draft, createNew: true })).toThrow("api_key_required");
    expect(() =>
      resolveAiConfigDraft({ ...draft, profileId: id, baseURL: "https://changed.test/v1" }),
    ).toThrow("api_key_required");
    expect(() =>
      resolveAiConfigDraft({ provider: "deepseek", model: "m", baseURL: "https://new.test/v1" }),
    ).toThrow("api_key_required");
    vi.spyOn(aiConfigStore, "read").mockReturnValue({ ...draft, apiKey: "private-saved" });
    const publicConfig = getPublicAiConfig(true);
    expect(publicConfig.profiles[0]).toEqual({ ...draft, id, name: "DS", hasApiKey: true });
    expect(JSON.stringify(publicConfig)).not.toContain("private");
  });
  it("never exposes API key, including environment URL credentials", () => {
    vi.spyOn(aiConfigStore, "read").mockReturnValue(null);
    vi.stubEnv("AI_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "private-key");
    vi.stubEnv("AI_BASE_URL", "https://private-key@example.com/?key=private-key");
    const config = getPublicAiConfig(false);
    expect(config.hasApiKey).toBe(true);
    expect(JSON.stringify(config)).not.toContain("private-key");
    expect(config.canEdit).toBe(false);
  });
});

describe("platform authorization", () => {
  it("oldest DB user alone owns configuration", async () => {
    vi.stubEnv("AI_CONFIG_ADMIN_EMAIL", "");
    vi.mocked(db.user.findFirst).mockResolvedValue({ id: "oldest" } as never);
    expect(await canEditAiConfig("newer")).toBe(false);
    expect(await canEditAiConfig("oldest")).toBe(true);
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    );
  });
  it("explicit admin email supersedes oldest user", async () => {
    vi.stubEnv("AI_CONFIG_ADMIN_EMAIL", "Admin@example.com");
    vi.mocked(db.user.findUnique).mockResolvedValue({ email: "admin@example.com" } as never);
    expect(await canEditAiConfig("admin")).toBe(true);
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });
  it("blocks globally active including paused tasks", async () => {
    vi.mocked(db.agentTask.findFirst).mockResolvedValue({ id: "task" } as never);
    expect(await hasActiveAiTasks()).toBe(true);
    expect(db.agentTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: expect.arrayContaining(["paused", "queued", "coding"]) } },
      }),
    );
  });
});

describe("explicit connection probe (mock only)", () => {
  it("uses 20 tokens, no retries, abort signal and never returns generated text", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "private-provider-output" } as never);
    const result = await testAiConnection({ OPENAI_API_KEY: "mock-key" });
    expect(result).toMatchObject({ ok: true, tested: true });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 20,
        maxRetries: 0,
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });
  it("masks upstream errors", async () => {
    vi.mocked(generateText).mockRejectedValue(
      new Error("secret-key upstream-body https://private"),
    );
    expect(await testAiConnection({ OPENAI_API_KEY: "mock-key" })).toEqual({
      ok: false,
      code: "connection_failed",
    });
  });
  it("times out after 15 seconds even if SDK ignores abort", async () => {
    vi.useFakeTimers();
    vi.mocked(generateText).mockReturnValue(new Promise(() => {}));
    const result = testAiConnection({ OPENAI_API_KEY: "mock-key" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual({ ok: false, code: "connection_timeout" });
  });
});
