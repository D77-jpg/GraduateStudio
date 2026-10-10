import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { searchWorkspace } from "@/server/workspace/search";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** 全局内容搜索:?q= 关键词 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const result = searchWorkspace(id, session.user.id, query);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError("workspace.search", error);
  }
}
