import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { assertProjectOwner, buildProjectRequirementText } from "@/server/agents/context";
import {
  generateArchitectureOverview,
  generateDatabaseSchema,
} from "@/server/agents/architect-agent";
import {
  ArchitectureStateError,
  generateArchitectureDraft,
  getArchitecture,
} from "@/server/architecture";
import { logActivity } from "@/server/activity";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** AI 生成系统架构(草稿)。已确认的架构不会被覆盖。 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const { projectText, requirementText } = await buildProjectRequirementText(id, session.user.id);
    if (requirementText.startsWith("(尚未生成")) {
      return jsonError(409, "requirement_missing", "请先生成需求分析,再让 AI 设计架构");
    }

    const overview = await generateArchitectureOverview({ projectText, requirementText });
    const database = await generateDatabaseSchema({
      projectText,
      requirementText,
      architectureSummary: overview.summary,
      existingTableNames: [],
    });
    const architecture = await generateArchitectureDraft(id, session.user.id, overview, database);
    await logActivity(
      id,
      "ai",
      "AI 生成系统架构(草稿)",
      `${overview.techStack.length} 项技术栈 · ${overview.apis.length} 个 API · ${database.tables.length} 张表`,
    );
    return NextResponse.json({ architecture });
  } catch (error) {
    if (error instanceof ArchitectureStateError) {
      return jsonError(409, "architecture_confirmed", error.message);
    }
    return handleRouteError("architecture.generate", error);
  }
}

/** 草稿状态查询(供重新分析按钮判断)。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const architecture = await getArchitecture(id, session.user.id);
    return NextResponse.json({ architecture });
  } catch (error) {
    return handleRouteError("architecture.generate.get", error);
  }
}
