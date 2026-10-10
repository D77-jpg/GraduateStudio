import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { ensureWorkspaceScaffolded } from "@/server/workspace/scaffold";
import { listFileTree } from "@/server/workspace/files";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** 文件树:首次进入时若无文件则初始化脚手架。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const { scaffolded } = await ensureWorkspaceScaffolded(id, session.user.id);
    const tree = listFileTree(id, session.user.id);
    return NextResponse.json({ tree, scaffolded });
  } catch (error) {
    return handleRouteError("workspace.files", error);
  }
}
