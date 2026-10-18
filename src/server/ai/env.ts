import { z } from "zod";
import { aiConfigStore, type SavedAiConfig } from "./config-store";

/**
 * AI Provider 注册表配置。
 * Phase 0 只建立"环境变量 → 可用 Provider → 模型实例"的最小链路,
 * 真正的生成/流式调用由 Phase 2 起的 Agent 模块基于此构建。
 */

export const AI_PROVIDER_IDS = ["openai", "anthropic", "deepseek", "glm", "openrouter"] as const;

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

const envSchema = z.object({
  AI_PROVIDER: z.enum(AI_PROVIDER_IDS).optional(),
  AI_DEFAULT_MODEL: z.string().min(1).optional(),
  // 应用级密钥:优先级高于 OPENAI_API_KEY,用于规避系统环境变量中失效旧值的阴影
  AI_OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().min(1).optional(),
  AI_BASE_URL: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  GLM_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
});

export type AiEnv = z.infer<typeof envSchema>;

function normalize(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    const trimmed = value?.trim();
    out[key] = trimmed ? trimmed : undefined;
  }
  return out;
}

export function getAiEnv(source?: Record<string, string | undefined>): AiEnv {
  const parsed = envSchema.safeParse(normalize(source ?? process.env));
  const env = parsed.success ? parsed.data : {};
  // Explicit sources remain pure: tests and connection drafts never read persisted state.
  if (source !== undefined) return env;
  const saved = aiConfigStore.read();
  return saved ? overlayAiConfig(env, saved) : env;
}

export function getProviderApiKey(env: AiEnv, provider: AiProviderId): string | undefined {
  if (provider === "openai") return getOpenAiApiKey(env);
  const keys = {
    anthropic: env.ANTHROPIC_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
    glm: env.GLM_API_KEY,
    openrouter: env.OPENROUTER_API_KEY,
  };
  return keys[provider];
}

export function overlayAiConfig(env: AiEnv, config: SavedAiConfig): AiEnv {
  const out: AiEnv = {
    ...env,
    AI_PROVIDER: config.provider,
    AI_DEFAULT_MODEL: config.model,
    AI_BASE_URL: config.baseURL || undefined,
  };
  // A blank saved baseURL requests the provider default, not a different environment gateway.
  out.OPENAI_BASE_URL = undefined;
  if (config.apiKey) {
    if (config.provider === "openai") out.AI_OPENAI_API_KEY = config.apiKey;
    else if (config.provider === "anthropic") out.ANTHROPIC_API_KEY = config.apiKey;
    else if (config.provider === "deepseek") out.DEEPSEEK_API_KEY = config.apiKey;
    else if (config.provider === "glm") out.GLM_API_KEY = config.apiKey;
    else out.OPENROUTER_API_KEY = config.apiKey;
  }
  return out;
}

/** openai(及兼容网关)的生效密钥:AI_OPENAI_API_KEY 优先,回退 OPENAI_API_KEY。 */
export function getOpenAiApiKey(env: AiEnv): string | undefined {
  return env.AI_OPENAI_API_KEY ?? env.OPENAI_API_KEY;
}

/** 按 AI_PROVIDER_IDS 的优先级返回已配置密钥的 Provider。 */
export function getAvailableProviders(env: AiEnv = getAiEnv()): AiProviderId[] {
  const availableByKey: Record<AiProviderId, boolean> = {
    openai: Boolean(getOpenAiApiKey(env)),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    deepseek: Boolean(env.DEEPSEEK_API_KEY),
    glm: Boolean(env.GLM_API_KEY),
    openrouter: Boolean(env.OPENROUTER_API_KEY),
  };
  return AI_PROVIDER_IDS.filter((id) => availableByKey[id]);
}

export function isAiConfigured(env: AiEnv = getAiEnv()): boolean {
  return getAvailableProviders(env).length > 0;
}
