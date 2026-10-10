import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import {
  ArchitectureStateError,
  confirmArchitecture,
  discardArchitecture,
  unconfirmArchitecture,
} from "@/server/architecture";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ action: z.enum(["confirm", "unconfirm", "discard"]) });

/** 架构状态流转:确认 / 撤销确认 / 拒绝丢弃草稿。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return jsonError(400, "invalid_input", "action 不合法");

    let message = null;
    if (parsed.data.action === "confirm") {
      await confirmArchitecture(id, session.user.id);
      message = "架构已确认";
    } else if (parsed.data.action === "unconfirm") {
      await unconfirmArchitecture(id, session.user.id);
      message = "已撤销确认,可重新生成";
    } else {
      await discardArchitecture(id, session.user.id);
      message = "已丢弃草稿";
    }
    return NextResponse.json({ ok: true, message });
  } catch (error) {
    if (error instanceof ArchitectureStateError) {
      return jsonError(409, "invalid_state", error.message);
    }
    return handleRouteError("architecture.status", error);
  }
}
