import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { addFeature, getRequirementByProject } from "@/server/requirements";
import { featureInputSchema } from "@/lib/requirements";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

const bodySchema = featureInputSchema.extend({
  parentId: z.string().min(1).nullable().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "输入不合法");
    }

    await addFeature(id, session.user.id, {
      parentId: parsed.data.parentId ?? null,
      name: parsed.data.name,
      description: parsed.data.description,
      priority: parsed.data.priority,
    });
    const requirement = await getRequirementByProject(id, session.user.id);
    return NextResponse.json({ requirement }, { status: 201 });
  } catch (error) {
    return handleRouteError("features.create", error);
  }
}
