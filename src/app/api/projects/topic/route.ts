import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { generateTopicProposal } from "@/server/ai/generate";
import { DIFFICULTIES, PROJECT_TYPES } from "@/lib/projects";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({
  idea: z.string().trim().min(5, "想法太短了,再多描述一点").max(500, "想法描述过长"),
  type: z.enum(PROJECT_TYPES).optional(),
  devLanguage: z.string().trim().max(40).optional(),
  database: z.string().trim().max(40).optional(),
  difficulty: z.enum(DIFFICULTIES).optional(),
  needsAi: z.boolean().optional(),
});

/** AI 选题:输入模糊想法,返回结构化选题方案(不落库,由前端确认后走创建接口)。 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "输入不合法");
    }

    const proposal = await generateTopicProposal(parsed.data);
    return NextResponse.json({ proposal });
  } catch (error) {
    return handleRouteError("projects.topic", error);
  }
}
