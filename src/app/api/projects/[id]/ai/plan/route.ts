import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { generatePlan } from "@/server/agents/coding-agent";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({
  message: z.string().trim().min(2, "请描述你的开发任务").max(2000),
  selectedFilePaths: z.array(z.string().min(1)).max(5).default([]),
});

/** AI 生成修改计划(不写盘、不改文件,只产出计划)。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "输入不合法");
    }

    const plan = await generatePlan({
      projectId: id,
      userId: session.user.id,
      message: parsed.data.message,
      selectedFilePaths: parsed.data.selectedFilePaths,
    });
    return NextResponse.json({ plan });
  } catch (error) {
    return handleRouteError("agent.plan", error);
  }
}
