import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  isOfficialDeepSeekFlash,
  officialDeepSeekStructuredFetch,
  type ChatRequestPolicy,
} from "./request-policy";
import {
  getAiEnv,
  getAvailableProviders,
  getProviderApiKey,
  type AiEnv,
  type AiProviderId,
} from "./env";

/**
 * 各 Provider 的兜底模型。仅在使用方未显式指定时生效,
 * 可通过 AI_DEFAULT_MODEL 覆盖;默认值随官方模型演进可能过期,
 * 调用时若模型 ID 失效应优先检查环境变量配置。
 */
export const DEFAULT_MODELS: Record<AiProviderId, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5",
  deepseek: "deepseek-chat",
  glm: "glm-4-flash",
  openrouter: "openai/gpt-4o-mini",
};

/** deepseek / glm / openrouter 均为 OpenAI 兼容接口,复用 createOpenAI 并改写 baseURL。 */
const BASE_URLS: Record<AiProviderId, string | undefined> = {
  openai: undefined, // 可通过 OPENAI_BASE_URL 指向 OpenAI 兼容网关
  anthropic: undefined,
  deepseek: "https://api.deepseek.com/v1",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  openrouter: "https://openrouter.ai/api/v1",
};

export class AiNotConfiguredError extends Error {
  constructor() {
    super("尚未配置任何 AI Provider,请在 .env 中设置至少一个 API Key(参见 .env.example)");
    this.name = "AiNotConfiguredError";
  }
}

export function resolveProviderSelection(env: AiEnv = getAiEnv()): {
  provider: AiProviderId;
  model: string;
} {
  const available = getAvailableProviders(env);
  if (available.length === 0) throw new AiNotConfiguredError();

  const preferred = env.AI_PROVIDER;
  if (preferred && !available.includes(preferred)) throw new AiNotConfiguredError();
  const provider = preferred ?? available[0];
  const model = env.AI_DEFAULT_MODEL ?? DEFAULT_MODELS[provider];
  return { provider, model };
}

export function resolveProviderBaseURL(env: AiEnv, provider: AiProviderId): string | undefined {
  return (
    env.AI_BASE_URL ??
    (provider === "openai" ? env.OPENAI_BASE_URL : undefined) ??
    BASE_URLS[provider]
  );
}

/** 返回 AI SDK 的模型实例;仅在已配置对应密钥时可用。 */
export function getChatModel(env: AiEnv = getAiEnv(), policy?: ChatRequestPolicy) {
  const { provider, model } = resolveProviderSelection(env);

  if (provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new AiNotConfiguredError();
    return createAnthropic({ apiKey, baseURL: resolveProviderBaseURL(env, provider) })(model);
  }

  const apiKey = getProviderApiKey(env, provider);
  if (!apiKey) throw new AiNotConfiguredError();
  const baseURL = resolveProviderBaseURL(env, provider);
  // 显式使用 chat completions:OpenAI 兼容网关普遍不支持 /v1/responses
  return createOpenAI({
    apiKey,
    baseURL,
    ...(policy?.structuredGeneration && isOfficialDeepSeekFlash({ provider, model }, baseURL)
      ? { fetch: officialDeepSeekStructuredFetch(globalThis.fetch) }
      : {}),
  }).chat(model);
}
