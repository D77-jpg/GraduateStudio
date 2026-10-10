import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { db } from "@/server/db";
import { sectionDefsForType } from "@/server/documents/generator";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/** 文档列表(章节统计 + 已生成进度)。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");
    await assertProjectOwner(id, session.user.id);

    const docs = await db.document.findMany({
      where: { projectId: id },
      orderBy: { updatedAt: "desc" },
      include: { sections: { orderBy: { order: "asc" } } },
    });

    return NextResponse.json({
      documents: docs.map((doc) => ({
        id: doc.id,
        type: doc.type,
        title: doc.title,
        status: doc.status,
        updatedAt: doc.updatedAt.toISOString(),
        totalSections: doc.sections.length,
        generatedSections: doc.sections.filter((s) => s.content.trim()).length,
      })),
    });
  } catch (error) {
    return handleRouteError("documents.list", error);
  }
}

const createSchema = z.object({
  type: z.enum(["THESIS", "OPENING_REPORT", "TASK_BOOK", "LITERATURE_REVIEW"]),
  title: z.string().trim().min(2).max(120).optional(),
});

/** 创建文档 + 章节骨架(每种类型一个文档)。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");
    await assertProjectOwner(id, session.user.id);

    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return jsonError(400, "invalid_input", "type 不合法");
    const { type } = parsed.data;

    const project = await db.project.findFirst({ where: { id }, select: { name: true } });
    if (!project) return jsonError(404, "not_found", "项目不存在");

    const existing = await db.document.findUnique({
      where: { projectId_type: { projectId: id, type } },
      select: { id: true },
    });
    if (existing) return jsonError(409, "already_exists", "该类型文档已存在");

    const defaults: Record<string, string> = {
      THESIS: "毕业设计说明书",
      OPENING_REPORT: "开题报告",
      TASK_BOOK: "任务书",
      LITERATURE_REVIEW: "文献综述",
    };
    const title = parsed.data.title ?? `${project.name} ${defaults[type] ?? type}`;

    const doc = await db.document.create({
      data: { projectId: id, type, title, status: "draft" },
    });
    await db.documentSection.createMany({
      data: sectionDefsForType(type).map((def, index) => ({
        documentId: doc.id,
        key: def.key,
        title: def.title,
        order: index,
      })),
    });

    return NextResponse.json(
      { document: { id: doc.id, type: doc.type, title: doc.title } },
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError("documents.create", error);
  }
}
