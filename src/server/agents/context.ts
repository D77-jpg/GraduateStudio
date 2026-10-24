import { db } from "@/server/db";
import { listProjectFilePaths, isTextFilePath } from "@/server/workspace/search";
import { readFileContent } from "@/server/workspace/files";
import {
  assertSafeGenerationPath,
  assertFullRewriteContext,
  prioritizePlanningFiles,
} from "@/lib/generation-quality";
import { buildFeatureTree } from "@/lib/requirements";
import { toProjectDto } from "@/server/projects";

/**
 * AI 上下文构建。
 * buildProjectRequirementText:项目元信息 + 需求分析文本(架构师/编码 Agent 共用);
 * buildCodingContext:在其上叠加工作区文件、选中文件内容、最近变更(编码 Agent 用)。
 */

export interface ProjectRequirementText {
  projectText: string;
  requirementText: string;
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function buildProjectRequirementText(
  projectId: string,
  userId: string,
): Promise<ProjectRequirementText> {
  const projectRow = await db.project.findFirst({ where: { id: projectId, userId } });
  if (!projectRow) throw new Error("项目不存在或无权访问");
  const project = toProjectDto(projectRow);

  const projectText = [
    `项目名称:${project.name}`,
    project.description ? `项目简介:${project.description}` : null,
    `项目类型:${project.type}`,
    project.techStack.length ? `技术栈:${project.techStack.join("、")}` : null,
    project.devLanguage ? `开发语言:${project.devLanguage}` : null,
    project.database ? `数据库:${project.database}` : null,
    project.difficulty ? `难度:${project.difficulty}` : null,
    project.needsAi ? "项目包含 AI 能力" : null,
    project.background ? `项目背景:${project.background}` : null,
    project.goals.length ? `项目目标:\n${project.goals.map((g) => `- ${g}`).join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const requirementRow = await db.requirement.findUnique({
    where: { projectId },
    include: {
      features: {
        select: {
          id: true,
          parentId: true,
          name: true,
          description: true,
          priority: true,
          order: true,
        },
      },
    },
  });

  let requirementText = "(尚未生成需求分析)";
  if (requirementRow) {
    const roles = await db.userRole.findMany({
      where: { requirementId: requirementRow.id },
      orderBy: { order: "asc" },
    });
    const tree = buildFeatureTree(
      requirementRow.features.map((f) => ({ ...f, priority: f.priority, order: f.order })),
    );
    const lines: string[] = [];
    if (roles.length) {
      lines.push("用户角色:", ...roles.map((r) => `- ${r.name}:${r.description}`));
    }
    if (tree.length) {
      lines.push("功能模块:");
      for (const featureModule of tree) {
        lines.push(`- ${featureModule.name}`);
        for (const child of featureModule.children) {
          lines.push(`  - ${child.name}${child.description ? `(${child.description})` : ""}`);
        }
      }
    }
    const flows = safeJson<Array<{ name: string; steps: string[] }>>(
      requirementRow.businessFlows,
      [],
    );
    if (flows.length) {
      lines.push("核心业务流程:");
      for (const flow of flows) {
        lines.push(`- ${flow.name}:${flow.steps.join(" → ")}`);
      }
    }
    const nonFunctional = safeJson<string[]>(requirementRow.nonFunctional, []);
    if (nonFunctional.length) {
      lines.push("非功能需求:", ...nonFunctional.map((n) => `- ${n}`));
    }
    const boundaries = safeJson<{ inScope: string[]; outOfScope: string[] }>(
      requirementRow.boundaries,
      { inScope: [], outOfScope: [] },
    );
    if (boundaries.inScope.length || boundaries.outOfScope.length) {
      lines.push(
        "系统边界:",
        `- 范围内:${boundaries.inScope.join("、") || "无"}`,
        `- 范围外:${boundaries.outOfScope.join("、") || "无"}`,
      );
    }
    requirementText = lines.join("\n") || "(需求分析为空)";
  }

  return { projectText, requirementText };
}

export async function assertProjectOwner(projectId: string, userId: string): Promise<void> {
  const project = await db.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!project) throw new Error("项目不存在或无权访问");
}

export interface CodingContext {
  projectText: string;
  fileTreeText: string;
  selectedFilesText: string;
  requirementText: string;
  recentChangesText: string;
  architectureText: string;
}

export async function buildCodingContext(
  projectId: string,
  userId: string,
  selectedFilePaths: string[] = [],
  options: { requiredFullFilePaths?: string[]; autoSelectPlanningFiles?: boolean } = {},
): Promise<CodingContext> {
  const { projectText, requirementText } = await buildProjectRequirementText(projectId, userId);

  const allPaths = listProjectFilePaths(projectId, userId);
  const visiblePaths = prioritizePlanningFiles(allPaths);
  const fileTreeText = visiblePaths.length
    ? visiblePaths.map((p) => `- ${p}`).join("\n")
    : "(工作区为空)";

  const required = new Set(options.requiredFullFilePaths ?? []);
  const candidates = selectedFilePaths.length
    ? selectedFilePaths
    : options.autoSelectPlanningFiles
      ? prioritizePlanningFiles(allPaths).filter(isTextFilePath)
      : [];
  // Required rewrite files must never be displaced by optional selections.
  const paths = [...new Set([...required, ...candidates])];
  const selectedChunks: string[] = [];
  for (const p of paths) {
    assertSafeGenerationPath(p);
    let file: ReturnType<typeof readFileContent> | null = null;
    try {
      if (isTextFilePath(p)) file = readFileContent(projectId, userId, p);
    } catch {
      // Missing optional context (including future create targets) can be skipped.
    }
    if (required.has(p)) assertFullRewriteContext(p, file);
    if (!file || file.content.includes("\u0000")) continue;
    selectedChunks.push(
      `--- 文件:${p} ---\n${file.content}${file.truncated ? "\n…(文件读取结果不完整;不可据此完整重写此文件)" : ""}`,
    );
  }
  const selectedFilesText = selectedChunks.join("\n\n") || "(无选中文件)";

  const recent = await db.changeSet.findMany({
    where: { projectId, status: { in: ["accepted", "undone"] } },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { title: true, status: true },
  });
  const recentChangesText = recent.length
    ? recent.map((c) => `- [${c.status}] ${c.title}`).join("\n")
    : "(暂无变更历史)";

  // 系统架构 + 数据库设计(Phase 3 产出;已确认或草稿都纳入上下文)
  const architectureText = await buildArchitectureText(projectId, userId);

  return {
    projectText,
    fileTreeText,
    selectedFilesText,
    requirementText,
    recentChangesText,
    architectureText,
  };
}

/** 架构阶段产出的文本化表示（编码 Agent 与 Codex 完整开发共用）。 */
export async function buildArchitectureText(projectId: string, userId: string): Promise<string> {
  const { getArchitecture } = await import("@/server/architecture");
  const architecture = await getArchitecture(projectId, userId);
  let architectureText = "(系统架构与数据库设计尚未生成)";
  if (architecture) {
    const lines: string[] = [
      `[架构状态:${architecture.status === "confirmed" ? "已确认" : "草稿"}]`,
      `架构总览:${architecture.summary}`,
      `前端架构:${architecture.frontendArch}`,
      `后端架构:${architecture.backendArch}`,
      "",
      "技术栈:",
      ...architecture.techStack.map((t) => `- [${t.layer}] ${t.name}:${t.reason}`),
      "",
      "系统模块:",
      ...architecture.modules.map((m) => `- ${m.name}(${m.layer}):${m.description}`),
      "",
      "API 规划:",
      ...architecture.apis.map(
        (a) =>
          `- ${a.method} ${a.path} [${a.module}]${a.requiresAuth ? "(需登录)" : "(公开)"}:${a.summary}`,
      ),
      "",
      "权限设计:",
      ...architecture.permissions.map(
        (p) => `- ${p.role} → ${p.resource}:${p.action}${p.note ? `(${p.note})` : ""}`,
      ),
      "",
      "项目目录结构:",
      architecture.directoryTree,
    ];
    if (architecture.database && architecture.database.tables.length > 0) {
      lines.push("", `数据库(${architecture.database.engine}):`);
      for (const table of architecture.database.tables) {
        lines.push(
          `- ${table.name}:${table.fields
            .map(
              (f) =>
                `${f.name} ${f.type}${f.isPrimary ? " PK" : ""}${f.isUnique ? " UQ" : ""}${f.nullable ? "" : " NOT NULL"}`,
            )
            .join("; ")}`,
        );
      }
      lines.push(
        "表关系:",
        ...architecture.database.relations.map(
          (r) => `- ${r.fromTable}.${r.fromField} → ${r.toTable}.${r.toField} (${r.kind})`,
        ),
      );
    }
    architectureText = lines.join("\n");
  }

  return architectureText;
}

export function renderContextForPrompt(context: CodingContext): string {
  return [
    "## 项目信息",
    context.projectText,
    "",
    "## 需求分析",
    context.requirementText,
    "",
    "## 系统架构/数据库",
    context.architectureText,
    "",
    "## 工作区文件",
    context.fileTreeText,
    "",
    "## 用户当前打开的文件",
    context.selectedFilesText,
    "",
    "## 最近变更历史",
    context.recentChangesText,
  ].join("\n");
}
