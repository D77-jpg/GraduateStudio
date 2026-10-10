import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { generateImplementation } from "@/server/agents/coding-agent";
import { createPendingChangeSet } from "@/server/changesets";
import { planOutputSchema } from "@/lib/develop";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({
  message: z.string().trim().min(2).max(2000),
  plan: planOutputSchema,
  selectedFilePaths: z.array(z.string().min(1)).max(5).default([]),
});

/** 执行计划:AI 生成各文件的完整内容,产出 pending 变更集(待用户 Accept/Reject)。 */
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
    const { message, plan, selectedFilePaths } = parsed.data;

    const output = await generateImplementation({
      projectId: id,
      userId: session.user.id,
      message,
      plan,
      selectedFilePaths,
    });

    const changeSet = await createPendingChangeSet({
      projectId: id,
      userId: session.user.id,
      title: plan.title,
      summary: output.notes,
      plan: plan.steps,
      changes: output.changes.map((change) => ({
        path: change.path,
        action: change.action,
        content: change.content,
      })),
    });
    return NextResponse.json({ changeSet });
  } catch (error) {
    return handleRouteError("agent.implement", error);
  }
}
