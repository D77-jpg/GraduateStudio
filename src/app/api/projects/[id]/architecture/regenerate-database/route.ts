import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { assertProjectOwner, buildProjectRequirementText } from "@/server/agents/context";
import { generateDatabaseSchema } from "@/server/agents/architect-agent";
import {
  ArchitectureStateError,
  getArchitecture,
  regenerateDatabaseSection,
} from "@/server/architecture";
import { logActivity } from "@/server/activity";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 局部重新生成数据库设计(仅草稿状态;不影响其他架构内容)。 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const existing = await getArchitecture(id, session.user.id);
    if (!existing) return jsonError(409, "architecture_missing", "尚未生成架构");
    if (existing.status === "confirmed") {
      return jsonError(
        409,
        "architecture_confirmed",
        "已确认的架构不会被局部重新生成,请先撤销确认",
      );
    }

    const { projectText, requirementText } = await buildProjectRequirementText(id, session.user.id);
    const output = await generateDatabaseSchema({
      projectText,
      requirementText,
      architectureSummary: existing.summary,
      existingTableNames: existing.database?.tables.map((t) => t.name) ?? [],
    });

    const architecture = await regenerateDatabaseSection(id, session.user.id, output);
    await logActivity(id, "ai", "AI 局部重新生成数据库设计", `${output.tables.length} 张表`);
    return NextResponse.json({ architecture });
  } catch (error) {
    if (error instanceof ArchitectureStateError) {
      return jsonError(409, "invalid_state", error.message);
    }
    return handleRouteError("architecture.regenerateDb", error);
  }
}
