import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { buildDocumentMarkdown, buildDocumentDocx } from "@/server/documents/export";
import { DocumentError } from "@/server/documents/generator";
import { handleRouteError, jsonError } from "@/server/api-helpers";
import { logActivity } from "@/server/activity";

export const dynamic = "force-dynamic";

/** 导出:?format=md | docx(PDF 走前端浏览器打印)。 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  try {
    const { id, documentId } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");
    await assertProjectOwner(id, session.user.id);

    const format = new URL(request.url).searchParams.get("format") ?? "md";
    const safeTitle = (title: string) => title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);

    if (format === "md") {
      const { title, markdown } = await buildDocumentMarkdown(documentId, session.user.id);
      await logActivity(id, "file", `导出 Markdown:${title}`);
      return new Response(markdown, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeTitle(title))}.md`,
        },
      });
    }

    if (format === "docx") {
      const { title, buffer } = await buildDocumentDocx(documentId, session.user.id);
      await logActivity(id, "file", `导出 DOCX:${title}`);
      return new Response(new Uint8Array(buffer), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeTitle(title))}.docx`,
        },
      });
    }

    return jsonError(400, "invalid_format", "format 必须是 md 或 docx");
  } catch (error) {
    if (error instanceof DocumentError && error.code === "not_found") {
      return jsonError(404, "not_found", error.message);
    }
    return handleRouteError("documents.export", error);
  }
}
