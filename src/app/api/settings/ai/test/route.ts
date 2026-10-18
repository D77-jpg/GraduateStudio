import { auth } from "@/server/auth";
import { aiConfigInputSchema } from "@/server/ai/config-store";
import {
  aiConfigErrorResponse,
  canEditAiConfig,
  isSafeAiConfigRequest,
  resolveAiConfigDraft,
} from "@/server/ai/config-access";
import { testAiConnection } from "@/server/ai/config-test";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json(
        { error: { code: "unauthorized", message: "请先登录" } },
        { status: 401 },
      );
    if (!(await canEditAiConfig(session.user.id)))
      return Response.json(
        { error: { code: "forbidden", message: "只有平台配置管理员可以测试模型配置" } },
        { status: 403 },
      );
    if (!isSafeAiConfigRequest(request))
      return Response.json(
        { error: { code: "invalid_origin", message: "请求来源或格式不合法" } },
        { status: 403 },
      );
    const input = aiConfigInputSchema.safeParse(await request.json().catch(() => null));
    if (!input.success)
      return Response.json(
        { error: { code: "invalid_input", message: "模型配置不合法" } },
        { status: 400 },
      );
    const { env } = resolveAiConfigDraft(input.data);
    const result = await testAiConnection(env);
    if (!result.ok)
      return Response.json(
        {
          error: {
            code: result.code,
            message:
              result.code === "connection_timeout" ? "连接测试超时" : "连接测试失败，请检查配置",
          },
        },
        { status: result.code === "connection_timeout" ? 504 : 502 },
      );
    return Response.json(result);
  } catch (cause) {
    return aiConfigErrorResponse(cause);
  }
}
