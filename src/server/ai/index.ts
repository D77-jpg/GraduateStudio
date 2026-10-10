export {
  AI_PROVIDER_IDS,
  getAiEnv,
  getAvailableProviders,
  isAiConfigured,
  type AiEnv,
  type AiProviderId,
} from "./env";
export { AiNotConfiguredError, getChatModel, resolveProviderSelection } from "./provider";

import { getAiEnv, getAvailableProviders, type AiEnv } from "./env";
import { resolveProviderSelection } from "./provider";

export interface AiStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  available: string[];
}

/** 面向健康检查 / 设置页的汇总状态,不抛异常。 */
export function getAiStatus(env: AiEnv = getAiEnv()): AiStatus {
  const available = getAvailableProviders(env);
  if (available.length === 0) {
    return { configured: false, provider: null, model: null, available };
  }
  const { provider, model } = resolveProviderSelection(env);
  return { configured: true, provider, model, available };
}
