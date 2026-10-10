import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { getRequirementByProject, updateRequirement } from "@/server/requirements";
import { requirementUpdateSchema } from "@/lib/requirements";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const requirement = await getRequirementByProject(id, session.user.id);
    return NextResponse.json({ requirement });
  } catch (error) {
    return handleRouteError("requirement.get", error);
  }
}

/** 需求元信息编辑:背景/目标/角色/非功能/边界(整体替换传入字段)。 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const parsed = requirementUpdateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "输入不合法");
    }

    const requirement = await updateRequirement(id, session.user.id, parsed.data);
    return NextResponse.json({ requirement });
  } catch (error) {
    return handleRouteError("requirement.update", error);
  }
}
