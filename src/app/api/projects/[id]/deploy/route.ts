import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { getAiStatus } from "@/server/ai";
import {
  buildDeployment,
  deployUp,
  restartDeployment,
  stopDeployment,
  rollbackDeployment,
  fetchContainerLogs,
  getDeployStatus,
  getDeployLogsSince,
  DeployError,
  checkDockerAvailable,
} from "@/server/deploy/manager";
import { generateDeployAssets } from "@/server/deploy/generator";
import { AiNotConfiguredError } from "@/server/ai/provider";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Phase 11:部署中心(本地 Docker 优先)。
 * GET  ?resource=status | logs
 * POST ?action=generate-assets | build | deploy | restart | stop | rollback | fetch-logs
 */

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");
    await assertProjectOwner(id, session.user.id);

    const url = new URL(request.url);
    const resource = url.searchParams.get("resource") ?? "status";

    if (resource === "logs") {
      const since = Number(url.searchParams.get("since") ?? "0") || 0;
      return NextResponse.json(getDeployLogsSince(id, since));
    }

    const dockerAvailable = await checkDockerAvailable();
    const status = { ...getDeployStatus(id), dockerAvailable };
    return NextResponse.json({ status });
  } catch (error) {
    return handleRouteError("deploy.get", error);
  }
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate-assets") }),
  z.object({ action: z.literal("build") }),
  z.object({ action: z.literal("deploy") }),
  z.object({ action: z.literal("restart") }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("rollback"), tag: z.string().min(4).max(20) }),
  z.object({ action: z.literal("fetch-logs") }),
]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");
    await assertProjectOwner(id, session.user.id);

    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "输入不合法");
    }
    const body = parsed.data;

    if (body.action === "generate-assets") {
      const ai = getAiStatus();
      if (!ai.configured) return jsonError(503, "ai_not_configured", "尚未配置 AI Provider");
      const result = await generateDeployAssets({ projectId: id, userId: session.user.id });
      return NextResponse.json({ files: result.files });
    }

    if (body.action === "build") {
      const result = await buildDeployment(id);
      return NextResponse.json(result);
    }

    if (body.action === "deploy") {
      const result = await deployUp(id);
      return NextResponse.json(result);
    }

    if (body.action === "restart") {
      return NextResponse.json(await restartDeployment(id));
    }

    if (body.action === "stop") {
      return NextResponse.json(await stopDeployment(id));
    }

    if (body.action === "rollback") {
      return NextResponse.json(await rollbackDeployment(id, body.tag));
    }

    if (body.action === "fetch-logs") {
      await fetchContainerLogs(id);
      return NextResponse.json({ ok: true });
    }

    return jsonError(400, "invalid_action", "action 不合法");
  } catch (error) {
    if (error instanceof DeployError) {
      const status =
        error.code === "no_assets" ||
        error.code === "no_docker" ||
        error.code === "busy" ||
        error.code === "invalid_tag" ||
        error.code === "tag_not_found"
          ? 409
          : 500;
      return jsonError(status, error.code, error.message);
    }
    if (error instanceof AiNotConfiguredError) {
      return jsonError(503, "ai_not_configured", "尚未配置 AI Provider");
    }
    return handleRouteError("deploy.post", error);
  }
}
