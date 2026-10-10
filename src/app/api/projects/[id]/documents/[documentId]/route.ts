import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { db } from "@/server/db";
import { buildDocumentContext, type DependencySnapshot } from "@/server/documents/context";
import {
  sectionDefsForType,
  generateSectionContent,
  editSectionContent,
  buildShortProjectContext,
  DocumentError,
} from "@/server/documents/generator";
import { loadOwnedDocument, buildDocumentMarkdown } from "@/server/documents/export";
import { handleRouteError, jsonError } from "@/server/api-helpers";
import { logActivity } from "@/server/activity";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 文档详情与操作。
 * GET    → sections + versions + 每章节同步状态(stale 检测)
 * POST   → action: generate-section | edit-section | save-section | snapshot | restore-version
 */

function parseSnapshot(raw: string): Partial<DependencySnapshot> {
  try {
    return JSON.parse(raw) as Partial<DependencySnapshot>;
  } catch {
    return {};
  }
}

/** 同步检测:章节生成时的快照 vs 当前项目状态。 */
function detectStale(
  section: { sourceContext: string; generatedAt: Date | null },
  current: DependencySnapshot,
): string | null {
  if (!section.generatedAt) return null; // 未生成
  const snap = parseSnapshot(section.sourceContext);
  const reasons: string[] = [];
  if (snap.archUpdatedAt && current.archUpdatedAt && snap.archUpdatedAt !== current.archUpdatedAt) {
    reasons.push("系统架构已更新");
  }
  if (snap.dbSignature && current.dbSignature && snap.dbSignature !== current.dbSignature) {
    reasons.push("数据库设计已变更");
  }
  if (
    snap.latestCommitHash &&
    current.latestCommitHash &&
    snap.latestCommitHash !== current.latestCommitHash
  ) {
    reasons.push("代码有新提交");
  }
  if (
    snap.latestTestRunAt &&
    current.latestTestRunAt &&
    snap.latestTestRunAt !== current.latestTestRunAt
  ) {
    reasons.push("有新的测试运行");
  }
  return reasons.length ? reasons.join("、") : null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  try {
    const { id, documentId } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");
    await assertProjectOwner(id, session.user.id);

    const doc = await loadOwnedDocument(documentId, session.user.id);
    const sections = await db.documentSection.findMany({
      where: { documentId },
      orderBy: { order: "asc" },
    });
    const versions = await db.documentVersion.findMany({
      where: { documentId },
      orderBy: { version: "desc" },
      select: { id: true, version: true, changeReason: true, createdAt: true },
      take: 20,
    });
    const { snapshot } = await buildDocumentContext(id, session.user.id, []);

    return NextResponse.json({
      document: {
        id: doc.id,
        type: doc.type,
        title: doc.title,
        status: doc.status,
        updatedAt: doc.updatedAt.toISOString(),
      },
      sections: sections.map((s) => ({
        id: s.id,
        key: s.key,
        title: s.title,
        content: s.content,
        order: s.order,
        generatedAt: s.generatedAt?.toISOString() ?? null,
        updatedAt: s.updatedAt.toISOString(),
        staleReason: detectStale(s, snapshot),
      })),
      versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
    });
  } catch (error) {
    return handleRouteError("documents.detail", error);
  }
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("generate-section"),
    sectionId: z.string().min(1),
  }),
  z.object({
    action: z.literal("edit-section"),
    sectionId: z.string().min(1),
    mode: z.enum(["polish", "expand", "condense"]),
  }),
  z.object({
    action: z.literal("save-section"),
    sectionId: z.string().min(1),
    content: z.string().max(80_000),
  }),
  z.object({
    action: z.literal("snapshot"),
    changeReason: z.string().trim().min(1).max(200),
  }),
  z.object({
    action: z.literal("restore-version"),
    versionId: z.string().min(1),
  }),
]);

/** 组装章节标题列表(生成目录/呼应用)。 */
async function allTitles(documentId: string): Promise<string[]> {
  const rows = await db.documentSection.findMany({
    where: { documentId },
    orderBy: { order: "asc" },
    select: { title: true },
  });
  return rows.map((r) => r.title);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  try {
    const { id, documentId } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");
    await assertProjectOwner(id, session.user.id);

    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "输入不合法");
    }
    const body = parsed.data;
    await loadOwnedDocument(documentId, session.user.id);

    if (body.action === "generate-section") {
      const section = await db.documentSection.findFirst({
        where: { id: body.sectionId, documentId },
      });
      if (!section) return jsonError(404, "not_found", "章节不存在");
      const def = sectionDefsForType(
        (await loadOwnedDocument(documentId, session.user.id)).type,
      ).find((d) => d.key === section.key);
      if (!def) return jsonError(400, "invalid_section", "章节定义不存在");

      const { content, snapshot } = await generateSectionContent({
        projectId: id,
        userId: session.user.id,
        def,
        allSectionTitles: await allTitles(documentId),
      });
      const updated = await db.documentSection.update({
        where: { id: section.id },
        data: {
          content,
          generatedAt: new Date(),
          sourceContext: JSON.stringify(snapshot),
        },
      });
      await logActivity(id, "ai", `生成文档章节:${section.title}`, `正文 ${content.length} 字`);
      return NextResponse.json({
        section: {
          id: updated.id,
          title: updated.title,
          content: updated.content,
          generatedAt: updated.generatedAt?.toISOString() ?? null,
        },
      });
    }

    if (body.action === "edit-section") {
      const section = await db.documentSection.findFirst({
        where: { id: body.sectionId, documentId },
      });
      if (!section) return jsonError(404, "not_found", "章节不存在");
      if (!section.content.trim()) {
        return jsonError(409, "section_empty", "章节还没有内容,请先生成");
      }
      const { content } = await editSectionContent({
        mode: body.mode,
        title: section.title,
        content: section.content,
        projectContext: await buildShortProjectContext(id, session.user.id),
      });
      const updated = await db.documentSection.update({
        where: { id: section.id },
        data: { content, updatedAt: new Date() },
      });
      const modeLabel = body.mode === "polish" ? "润色" : body.mode === "expand" ? "扩写" : "缩写";
      await logActivity(id, "ai", `${modeLabel}文档章节:${section.title}`);
      return NextResponse.json({
        section: { id: updated.id, title: updated.title, content: updated.content },
      });
    }

    if (body.action === "save-section") {
      const section = await db.documentSection.findFirst({
        where: { id: body.sectionId, documentId },
      });
      if (!section) return jsonError(404, "not_found", "章节不存在");
      const updated = await db.documentSection.update({
        where: { id: section.id },
        data: { content: body.content },
      });
      return NextResponse.json({
        section: {
          id: updated.id,
          title: updated.title,
          content: updated.content,
          updatedAt: updated.updatedAt.toISOString(),
        },
      });
    }

    if (body.action === "snapshot") {
      const { markdown } = await buildDocumentMarkdown(documentId, session.user.id);
      const last = await db.documentVersion.findFirst({
        where: { documentId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const version = await db.documentVersion.create({
        data: {
          documentId,
          version: (last?.version ?? 0) + 1,
          content: markdown,
          changeReason: body.changeReason,
        },
      });
      await db.document.update({ where: { id: documentId }, data: { status: "draft" } });
      await logActivity(id, "file", `文档版本快照 v${version.version}:${body.changeReason}`);
      return NextResponse.json({
        version: {
          id: version.id,
          version: version.version,
          changeReason: version.changeReason,
          createdAt: version.createdAt.toISOString(),
        },
      });
    }

    if (body.action === "restore-version") {
      const version = await db.documentVersion.findFirst({
        where: { id: body.versionId, documentId },
      });
      if (!version) return jsonError(404, "not_found", "版本不存在");
      const { markdown } = await buildDocumentMarkdown(documentId, session.user.id);
      // 先给当前状态留快照,再恢复
      const last = await db.documentVersion.findFirst({
        where: { documentId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      await db.documentVersion.create({
        data: {
          documentId,
          version: (last?.version ?? 0) + 1,
          content: markdown,
          changeReason: `恢复 v${version.version} 前的自动备份`,
        },
      });
      await restoreSectionsFromMarkdown(documentId, version.content);
      await logActivity(id, "file", `恢复文档到版本 v${version.version}`);
      return NextResponse.json({ restored: version.version });
    }

    return jsonError(400, "invalid_action", "action 不合法");
  } catch (error) {
    if (error instanceof DocumentError) {
      const status =
        error.code === "not_found"
          ? 404
          : error.code === "abstract_not_ready" || error.code === "section_empty"
            ? 409
            : 500;
      return jsonError(status, error.code, error.message);
    }
    return handleRouteError("documents.action", error);
  }
}

/** 把版本快照的 Markdown 按章节标题切回 sections(# 拆分:## 章节标题 → 内容)。 */
async function restoreSectionsFromMarkdown(documentId: string, markdown: string): Promise<void> {
  const sections = await db.documentSection.findMany({
    where: { documentId },
    orderBy: { order: "asc" },
  });
  const lines = markdown.split("\n");
  const buckets = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      current = m[1].trim();
      if (!buckets.has(current)) buckets.set(current, []);
      continue;
    }
    if (current) buckets.get(current)!.push(line);
  }
  for (const section of sections) {
    const bucket = buckets.get(section.title);
    if (bucket) {
      await db.documentSection.update({
        where: { id: section.id },
        data: { content: bucket.join("\n").trim() },
      });
    }
  }
}
