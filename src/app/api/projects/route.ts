import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { createProject, listProjectsByUser } from "@/server/projects";
import { projectCreateSchema } from "@/lib/projects";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** 项目列表(Dashboard 使用)。 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const projects = await listProjectsByUser(session.user.id);
    return NextResponse.json({ projects });
  } catch (error) {
    return handleRouteError("projects.list", error);
  }
}

/** 创建项目:手动表单与「采用 AI 选题方案」共用。 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const parsed = projectCreateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "输入不合法");
    }

    const project = await createProject(session.user.id, parsed.data);
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return handleRouteError("projects.create", error);
  }
}
