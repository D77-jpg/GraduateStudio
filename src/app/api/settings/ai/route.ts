import { auth } from "@/server/auth";
import { aiConfigActionSchema, aiConfigInputSchema, aiConfigStore } from "@/server/ai/config-store";
import {
  aiConfigErrorResponse,
  canEditAiConfig,
  getPublicAiConfig,
  hasActiveAiTasks,
  isSafeAiConfigRequest,
  resolveAiConfigDraft,
} from "@/server/ai/config-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function error(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

function publicResponse() {
  const config = getPublicAiConfig(true);
  return Response.json({
    config,
    profiles: config.profiles,
    activeProfileId: config.activeProfileId,
  });
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) return error(401, "unauthorized", "请先登录");
    const canEdit = await canEditAiConfig(session.user.id);
    try {
      const config = getPublicAiConfig(canEdit);
      return Response.json(
        { config, profiles: config.profiles, activeProfileId: config.activeProfileId },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      // Fail closed for runtime use, but leave the owner a safe reset/repair path in settings.
      return Response.json(
        {
          config: {
            provider: "openai",
            model: "gpt-4o-mini",
            baseURL: "",
            hasApiKey: false,
            source: "saved",
            canEdit,
            profiles: [],
            activeProfileId: null,
          },
          profiles: [],
          activeProfileId: null,
          configError: "已保存配置无法读取或解密，请恢复环境配置或重新填写密钥保存。",
          configErrorCode: "config_unavailable",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch (cause) {
    return aiConfigErrorResponse(cause);
  }
}

async function authorizeMutation(request: Request, requireJson: boolean) {
  const session = await auth();
  if (!session?.user?.id) return error(401, "unauthorized", "请先登录");
  if (!(await canEditAiConfig(session.user.id)))
    return error(403, "forbidden", "只有平台配置管理员可以修改全局模型配置");
  if (!isSafeAiConfigRequest(request, requireJson))
    return error(403, "invalid_origin", "请求来源或格式不合法");
  if (await hasActiveAiTasks())
    return error(409, "active_tasks", "请先结束所有活动或暂停中的 AI 任务，再修改全局模型配置");
  return null;
}

export async function POST(request: Request) {
  try {
    const denied = await authorizeMutation(request, true);
    if (denied) return denied;
    const body = await request.json().catch(() => null);
    const action = aiConfigActionSchema.safeParse(body);
    if (action.success) {
      if (action.data.action === "activate") aiConfigStore.activate(action.data.profileId);
      else aiConfigStore.deleteProfile(action.data.profileId);
      return publicResponse();
    }
    const input = aiConfigInputSchema.safeParse(body);
    if (!input.success)
      return error(400, "invalid_input", "模型配置不合法，请检查提供方、模型和服务地址");
    const { config } = resolveAiConfigDraft(input.data);
    const { profileId, name, activate, createNew } = input.data;
    const options = { profileId, name, activate, createNew };
    if (Object.values(options).some((value) => value !== undefined))
      aiConfigStore.save(config, options);
    else aiConfigStore.save(config);
    return publicResponse();
  } catch (cause) {
    return aiConfigErrorResponse(cause);
  }
}

export async function DELETE(request: Request) {
  try {
    const denied = await authorizeMutation(request, false);
    if (denied) return denied;
    aiConfigStore.reset();
    return publicResponse();
  } catch (cause) {
    return aiConfigErrorResponse(cause);
  }
}
