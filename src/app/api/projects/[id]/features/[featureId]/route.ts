import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { deleteFeature, getRequirementByProject, updateFeature } from "@/server/requirements";
import { featureUpdateSchema } from "@/lib/requirements";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

const patchSchema = featureUpdateSchema;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; featureId: string }> },
) {
  try {
    const { id, featureId } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "输入不合法");
    }

    await updateFeature(id, session.user.id, featureId, parsed.data);
    const requirement = await getRequirementByProject(id, session.user.id);
    return NextResponse.json({ requirement });
  } catch (error) {
    return handleRouteError("features.update", error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; featureId: string }> },
) {
  try {
    const { id, featureId } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await deleteFeature(id, session.user.id, featureId);
    const requirement = await getRequirementByProject(id, session.user.id);
    return NextResponse.json({ requirement });
  } catch (error) {
    return handleRouteError("features.delete", error);
  }
}
