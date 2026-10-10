import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import {
  acceptChangeSet,
  listChangeSets,
  rejectChangeSet,
  restoreChangeSet,
  undoLatestChangeSet,
} from "@/server/changesets";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** 变更集历史 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const changeSets = await listChangeSets(id, session.user.id);
    return NextResponse.json({ changeSets });
  } catch (error) {
    return handleRouteError("changesets.list", error);
  }
}

/** 变更集操作:{ action: accept | reject | undo } */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const body = z
      .object({ action: z.enum(["accept", "reject", "undo"]), changeSetId: z.string().optional() })
      .safeParse(await request.json());
    if (!body.success) return jsonError(400, "invalid_input", "action 不合法");

    let changeSet;
    if (body.data.action === "undo") {
      changeSet = await undoLatestChangeSet(id, session.user.id);
    } else {
      if (!body.data.changeSetId) return jsonError(400, "invalid_input", "缺少 changeSetId");
      changeSet =
        body.data.action === "accept"
          ? await acceptChangeSet(body.data.changeSetId, session.user.id)
          : await rejectChangeSet(body.data.changeSetId, session.user.id);
    }
    return NextResponse.json({ changeSet });
  } catch (error) {
    return handleRouteError("changesets.action", error);
  }
}

/** 恢复被撤销的变更集:{ changeSetId } */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const body = z.object({ changeSetId: z.string().min(1) }).safeParse(await request.json());
    if (!body.success) return jsonError(400, "invalid_input", "缺少 changeSetId");

    const changeSet = await restoreChangeSet(body.data.changeSetId, session.user.id);
    return NextResponse.json({ changeSet });
  } catch (error) {
    return handleRouteError("changesets.restore", error);
  }
}
