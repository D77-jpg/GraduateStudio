import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { generateModuleFeatures } from "@/server/ai/generate";
import {
  getFeatureWithSiblings,
  getRequirementByProject,
  replaceModuleFeatures,
} from "@/server/requirements";
import { getProjectById } from "@/server/projects";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 单模块 AI 重新生成:替换该模块下的功能点。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const body = z.object({ moduleId: z.string().min(1) }).safeParse(await request.json());
    if (!body.success) return jsonError(400, "invalid_input", "缺少 moduleId");

    const project = await getProjectById(id, session.user.id);
    if (!project) return jsonError(404, "not_found", "项目不存在或无权访问");

    const { featureModule, siblings } = await getFeatureWithSiblings(
      id,
      session.user.id,
      body.data.moduleId,
    );

    const output = await generateModuleFeatures({
      project: { name: project.name, type: project.type, techStack: project.techStack },
      moduleName: featureModule.name,
      moduleDescription: featureModule.description,
      siblingModules: siblings,
    });

    await replaceModuleFeatures(
      id,
      session.user.id,
      featureModule.id,
      output.features.map((feature) => ({
        name: feature.name,
        description: feature.description ?? "",
        priority: feature.priority ?? "should",
      })),
    );

    const requirement = await getRequirementByProject(id, session.user.id);
    return NextResponse.json({ requirement });
  } catch (error) {
    return handleRouteError("requirement.regenerateModule", error);
  }
}
