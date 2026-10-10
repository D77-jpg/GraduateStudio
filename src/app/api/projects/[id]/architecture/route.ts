import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { getArchitecture } from "@/server/architecture";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** 当前架构(含技术栈/模块/API/权限/数据库设计)。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const architecture = await getArchitecture(id, session.user.id);
    return NextResponse.json({ architecture });
  } catch (error) {
    return handleRouteError("architecture.get", error);
  }
}
