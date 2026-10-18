import { db } from "../db";
import {
  AiConfigError,
  aiConfigStore,
  compatibleAiProfile,
  selectAiProfile,
  type AiConfigInput,
} from "./config-store";
import {
  getAiEnv,
  getAvailableProviders,
  getProviderApiKey,
  overlayAiConfig,
  type AiEnv,
} from "./env";
import { DEFAULT_MODELS, resolveProviderBaseURL } from "./provider";

export async function canEditAiConfig(userId: string): Promise<boolean> {
  const email = process.env.AI_CONFIG_ADMIN_EMAIL?.trim().toLowerCase();
  if (email) {
    const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
    return user?.email?.trim().toLowerCase() === email;
  }
  const oldest = await db.user.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return oldest?.id === userId;
}

export async function hasActiveAiTasks(): Promise<boolean> {
  return Boolean(
    await db.agentTask.findFirst({
      where: {
        status: {
          in: ["queued", "analyzing", "planning", "coding", "checking", "fixing", "paused"],
        },
      },
      select: { id: true },
    }),
  );
}

export function publicAiConfig(env: AiEnv, source: "saved" | "environment", canEdit: boolean) {
  const provider = env.AI_PROVIDER ?? getAvailableProviders(env)[0] ?? "openai";
  const baseURL = resolveProviderBaseURL(env, provider) ?? "";
  // Environment URLs are not validated by the legacy env schema. Never expose credentials/query tokens.
  let safeBaseURL = "";
  if (baseURL) {
    try {
      const url = new URL(baseURL);
      if (!url.username && !url.password && !url.search && !url.hash) safeBaseURL = baseURL;
    } catch {
      /* masked */
    }
  }
  return {
    provider,
    model: env.AI_DEFAULT_MODEL ?? DEFAULT_MODELS[provider],
    baseURL: safeBaseURL,
    hasApiKey: Boolean(getProviderApiKey(env, provider)),
    source,
    canEdit,
  };
}

export function getPublicAiConfig(canEdit: boolean) {
  const saved = aiConfigStore.read();
  const env = getAiEnv(process.env);
  const bundle = aiConfigStore.readProfiles();
  return {
    ...publicAiConfig(
      saved ? overlayAiConfig(env, saved) : env,
      saved ? "saved" : "environment",
      canEdit,
    ),
    activeProfileId: bundle.activeProfileId,
    profiles: bundle.profiles.map(({ id, name, provider, model, baseURL, apiKey }) => ({
      id,
      name,
      provider,
      model,
      baseURL,
      hasApiKey: Boolean(apiKey),
    })),
  };
}

export function resolveAiConfigDraft(input: AiConfigInput) {
  const env = getAiEnv(process.env);
  const previous = selectAiProfile(aiConfigStore.readProfiles(), input, input);
  const savedKey = previous && compatibleAiProfile(input, previous) ? previous.apiKey : undefined;
  const targetURL = resolveProviderBaseURL(overlayAiConfig({}, input), input.provider) ?? "";
  const environmentURL = resolveProviderBaseURL(env, input.provider) ?? "";
  const environmentKey =
    !input.createNew &&
    (!previous || compatibleAiProfile(input, previous)) &&
    targetURL === environmentURL
      ? getProviderApiKey(env, input.provider)
      : undefined;
  const apiKey = input.apiKey || savedKey || environmentKey;
  if (!apiKey) throw new AiConfigError("api_key_required");
  const config = { provider: input.provider, model: input.model, baseURL: input.baseURL, apiKey };
  return { config, env: overlayAiConfig(env, config) };
}

/** Cookie-authenticated mutations must be JSON and same-origin when an Origin header is supplied. */
export function isSafeAiConfigRequest(request: Request, requireJson = true): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  return (
    !requireJson ||
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json"
  );
}

export function aiConfigErrorResponse(error: unknown): Response {
  const code = error instanceof AiConfigError ? error.code : "config_unavailable";
  const status = code === "profile_not_found" ? 404 : code === "api_key_required" ? 400 : 503;
  const message =
    code === "auth_secret_required"
      ? "保存配置需要服务器设置 AUTH_SECRET"
      : code === "api_key_required"
        ? "请为所选提供方配置 API Key"
        : "模型配置暂不可用，可尝试重置配置";
  // Deliberately do not log exceptions: SDK and filesystem errors can include sensitive data.
  return Response.json({ error: { code, message } }, { status });
}
