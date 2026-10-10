import { describe, expect, it } from "vitest";
import { getAiEnv, getAvailableProviders, isAiConfigured, type AiEnv } from "@/server/ai/env";
import { AiNotConfiguredError, getChatModel, resolveProviderSelection } from "@/server/ai/provider";

function envWith(vars: Record<string, string>): AiEnv {
  return getAiEnv(vars);
}

describe("getAiEnv", () => {
  it("parses configured keys", () => {
    const env = envWith({ OPENAI_API_KEY: "sk-test" });
    expect(env.OPENAI_API_KEY).toBe("sk-test");
  });

  it("treats blank keys as unset", () => {
    const env = envWith({ OPENAI_API_KEY: "   " });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("supports app-level AI_OPENAI_API_KEY override", () => {
    const env = envWith({ OPENAI_API_KEY: "sk-stale", AI_OPENAI_API_KEY: "sk-new" });
    expect(env.AI_OPENAI_API_KEY).toBe("sk-new");
  });
});

describe("getAvailableProviders", () => {
  it("returns empty when nothing configured", () => {
    expect(getAvailableProviders(envWith({}))).toEqual([]);
    expect(isAiConfigured(envWith({}))).toBe(false);
  });

  it("returns providers in priority order", () => {
    const env = envWith({
      DEEPSEEK_API_KEY: "sk-ds",
      OPENAI_API_KEY: "sk-oa",
    });
    expect(getAvailableProviders(env)).toEqual(["openai", "deepseek"]);
  });

  it("counts AI_OPENAI_API_KEY alone as configured", () => {
    expect(isAiConfigured(envWith({ AI_OPENAI_API_KEY: "sk-new" }))).toBe(true);
    expect(getAvailableProviders(envWith({ AI_OPENAI_API_KEY: "sk-new" }))).toEqual(["openai"]);
  });
});

describe("resolveProviderSelection", () => {
  it("throws when nothing configured", () => {
    expect(() => resolveProviderSelection(envWith({}))).toThrow(AiNotConfiguredError);
  });

  it("defaults to first available provider and its default model", () => {
    const sel = resolveProviderSelection(envWith({ OPENAI_API_KEY: "sk-test" }));
    expect(sel).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("honors AI_PROVIDER when available", () => {
    const sel = resolveProviderSelection(
      envWith({ OPENAI_API_KEY: "k1", DEEPSEEK_API_KEY: "k2", AI_PROVIDER: "deepseek" }),
    );
    expect(sel).toEqual({ provider: "deepseek", model: "deepseek-chat" });
  });

  it("falls back when AI_PROVIDER is not configured", () => {
    const sel = resolveProviderSelection(
      envWith({ OPENAI_API_KEY: "k1", AI_PROVIDER: "anthropic" }),
    );
    expect(sel.provider).toBe("openai");
  });

  it("honors AI_DEFAULT_MODEL override", () => {
    const sel = resolveProviderSelection(
      envWith({ OPENAI_API_KEY: "k1", AI_DEFAULT_MODEL: "my-model" }),
    );
    expect(sel.model).toBe("my-model");
  });
});

describe("getChatModel", () => {
  it("creates a model instance without network access", () => {
    const model = getChatModel(envWith({ OPENAI_API_KEY: "sk-test" }));
    expect(model).toBeTruthy();
  });

  it("creates a model from app-level key override", () => {
    const model = getChatModel(
      envWith({ AI_OPENAI_API_KEY: "sk-new", AI_DEFAULT_MODEL: "cline-free/mimo-v2.6-flash" }),
    );
    expect(model).toBeTruthy();
  });

  it("throws when not configured", () => {
    expect(() => getChatModel(envWith({}))).toThrow(AiNotConfiguredError);
  });
});
