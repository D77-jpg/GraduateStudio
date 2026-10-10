import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { generateRequirementDraft } from "@/server/ai/generate";
import { replaceRequirementFromDraft } from "@/server/requirements";
import { getProjectById } from "@/server/projects";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** AI 需求分析:覆盖式重新生成(前端在覆盖前自行确认)。 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const project = await getProjectById(id, session.user.id);
    if (!project) return jsonError(404, "not_found", "项目不存在或无权访问");

    const draft = await generateRequirementDraft({
      name: project.name,
      description: project.description,
      type: project.type,
      techStack: project.techStack,
      difficulty: project.difficulty,
      background: project.background,
      goals: project.goals,
    });

    const requirement = await replaceRequirementFromDraft(id, session.user.id, draft);
    return NextResponse.json({ requirement });
  } catch (error) {
    return handleRouteError("requirement.generate", error);
  }
}
