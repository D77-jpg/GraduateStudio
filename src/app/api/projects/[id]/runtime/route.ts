import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import {
  getRuntimeStatus,
  startRuntime,
  stopRuntime,
  restartRuntime,
  buildRuntime,
  getLogsSince,
  ErNotConfiguredError,
} from "@/server/runtime/process-manager";
import { handleRouteError, jsonError } from "@/server/api-helpers";
import { readPythonPreviewLogin } from "@/server/runtime/python-stack";

export const dynamic = "force-dynamic";
export const maxDuration = 1200;

/** Runtime 状态(含可选增量日志:?logs=1&since=N)。 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const url = new URL(request.url);
    const wantLogs = url.searchParams.get("logs") === "1";
    const since = Number(url.searchParams.get("since") ?? "0") || 0;

    const status = getRuntimeStatus(id);
    const logs = wantLogs ? getLogsSince(id, since) : null;
    return NextResponse.json({
      status,
      ...(logs ? { logs: logs.logs, nextSeq: logs.nextSeq } : {}),
    });
  } catch (error) {
    return handleRouteError("runtime.status", error);
  }
}

/** Runtime 控制:?action=start|stop|restart|build */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const action = new URL(request.url).searchParams.get("action") ?? "";
    const userId = session.user.id;

    if (action === "preview-login") {
      const login = await readPythonPreviewLogin(id);
      return NextResponse.json(login, {
        headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
      });
    }
    if (action === "start") {
      const status = await startRuntime(id, userId);
      return NextResponse.json({ status });
    }
    if (action === "stop") {
      const status = await stopRuntime(id, userId);
      return NextResponse.json({ status });
    }
    if (action === "restart") {
      const status = await restartRuntime(id, userId);
      return NextResponse.json({ status });
    }
    if (action === "build") {
      const status = await buildRuntime(id, userId);
      return NextResponse.json({ status });
    }
    return jsonError(400, "invalid_action", "action 必须是 start|stop|restart|build|preview-login");
  } catch (error) {
    if (error instanceof ErNotConfiguredError) {
      return jsonError(409, "runtime_error", error.message);
    }
    return handleRouteError("runtime.control", error);
  }
}
