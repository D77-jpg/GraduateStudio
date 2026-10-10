import { db } from "@/server/db";
import {
  AlignmentType,
  Document as DocxDocument,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { DocumentError } from "./generator";

/**
 * Phase 9:导出。
 * Document + DocumentSection → 整篇 Markdown / DOCX(PDF 走浏览器打印)。
 */

const DOC_TITLES: Record<string, string> = {
  THESIS: "毕业设计说明书",
  OPENING_REPORT: "开题报告",
  TASK_BOOK: "任务书",
  LITERATURE_REVIEW: "文献综述",
};

/** 整篇 Markdown(标题 + 按章节顺序拼接)。 */
export async function buildDocumentMarkdown(
  documentId: string,
  userId: string,
): Promise<{ title: string; markdown: string }> {
  const doc = await loadOwnedDocument(documentId, userId);
  const sections = await db.documentSection.findMany({
    where: { documentId },
    orderBy: { order: "asc" },
  });
  const typeLabel = DOC_TITLES[doc.type] ?? doc.type;
  const parts = [
    `# ${doc.title}\n`,
    `> ${typeLabel} · 由 GraduateStudio 依据项目真实数据生成 · 更新于 ${doc.updatedAt.toISOString().slice(0, 10)}\n`,
    ...sections.map((s) => `\n## ${s.title}\n\n${s.content.trim() || "*(本章节尚未生成)*"}\n`),
  ];
  return { title: doc.title, markdown: parts.join("\n") };
}

export async function loadOwnedDocument(documentId: string, userId: string) {
  const doc = await db.document.findFirst({
    where: { id: documentId, project: { userId } },
  });
  if (!doc) throw new DocumentError("文档不存在或无权访问", "not_found");
  return doc;
}

/** 极简 Markdown → docx 段落(标题/列表/代码块/普通段落)。 */
function markdownToDocxParagraphs(markdown: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = markdown.split("\n");
  let inCode = false;
  let codeBuffer: string[] = [];

  const flushCode = () => {
    if (codeBuffer.length) {
      for (const line of codeBuffer) {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: line, font: "Consolas", size: 18 })],
            spacing: { after: 40 },
            indent: { left: 360 },
          }),
        );
      }
      codeBuffer = [];
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }
    if (!line.trim()) continue;

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const levelMap = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
      ];
      paragraphs.push(
        new Paragraph({
          text: stripInline(heading[2]),
          heading: levelMap[level - 1],
          spacing: { before: 240, after: 120 },
        }),
      );
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      paragraphs.push(
        new Paragraph({
          text: stripInline(bullet[1]),
          bullet: { level: 0 },
          spacing: { after: 60 },
        }),
      );
      continue;
    }
    const ordered = line.match(/^\s*(\d+)[.、]\s+(.*)$/);
    if (ordered) {
      paragraphs.push(
        new Paragraph({
          text: `${ordered[1]}. ${stripInline(ordered[2])}`,
          spacing: { after: 60 },
          indent: { left: 360 },
        }),
      );
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: stripInline(line.replace(/^\s*>\s?/, "")),
              italics: true,
              color: "666666",
            }),
          ],
          spacing: { after: 80 },
        }),
      );
      continue;
    }
    // 表格行:docx 生成表格复杂度高,降级为等宽文本行(保留可读性)
    if (line.trim().startsWith("|")) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: line.trim().replace(/\s*\|\s*/g, " | "),
              font: "Consolas",
              size: 19,
            }),
          ],
          spacing: { after: 20 },
        }),
      );
      continue;
    }
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: stripInline(line), size: 24 })],
        spacing: { after: 120, line: 360 },
        alignment: AlignmentType.JUSTIFIED,
      }),
    );
  }
  flushCode();
  return paragraphs;
}

function stripInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

/** 生成 DOCX 文件(Buffer)。 */
export async function buildDocumentDocx(
  documentId: string,
  userId: string,
): Promise<{ title: string; buffer: Buffer }> {
  const { title, markdown } = await buildDocumentMarkdown(documentId, userId);
  const doc = new DocxDocument({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            text: title,
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { after: 360 },
          }),
          ...markdownToDocxParagraphs(markdown),
        ],
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);
  return { title, buffer };
}
