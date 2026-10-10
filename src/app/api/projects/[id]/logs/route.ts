import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { listActivityLogs } from "@/server/activity";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** 活动日志(Logs 面板)。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const logs = await listActivityLogs(id, session.user.id, 150);
    return NextResponse.json({ logs });
  } catch (error) {
    return handleRouteError("logs.list", error);
  }
}
