import type { AiProviderId } from "./env";

export type ChatRequestPolicy = { structuredGeneration: true };

export const DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS = 393_216;

/** Only the official, explicitly selected Flash model has this verified wire contract.
 * No aliases: a gateway or another model must not inherit official-only settings.
 */
export function isOfficialDeepSeekFlash(
  selection: { provider: AiProviderId; model: string },
  baseURL: string | undefined,
): boolean {
  if (selection.provider !== "deepseek" || selection.model !== "deepseek-flash" || !baseURL)
    return false;
  try {
    const url = new URL(baseURL);
    return (
      url.protocol === "https:" && url.host === "api.deepseek.com" && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

/** The installed OpenAI chat SDK accepts reasoningEffort, but responseFormat is
 * a model-call setting, not a providerOption; thinking is not an SDK option.
 * Fill those two wire fields here, scoped both at model creation and dispatch.
 * Ordinary connection tests and all generic gateways retain the SDK body.
 */
export function officialDeepSeekStructuredFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (
      url.protocol === "https:" &&
      url.host === "api.deepseek.com" &&
      /\/chat\/completions\/?$/.test(url.pathname) &&
      init?.method?.toUpperCase() === "POST" &&
      typeof init.body === "string"
    ) {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (body.model === "deepseek-flash") {
        return fetchImpl(input, {
          ...init,
          body: JSON.stringify({
            ...body,
            max_tokens: body.max_tokens ?? DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
            response_format: { type: "json_object" },
            thinking: { type: "enabled" },
            reasoning_effort: "high",
          }),
        });
      }
    }
    return fetchImpl(input, init);
  };
}
