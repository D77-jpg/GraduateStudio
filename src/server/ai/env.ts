import { z } from "zod";

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

export function getAiEnv(source: Record<string, string | undefined> = process.env): AiEnv {
  const parsed = envSchema.safeParse(normalize(source));
  return parsed.success ? parsed.data : {};
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
