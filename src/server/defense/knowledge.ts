import { db } from "@/server/db";
import { buildDocumentContext, joinContext } from "@/server/documents/context";
import { listCommits } from "@/server/git";

/**
 * Phase 10:答辩项目知识库。
 * 复用文档中心的真实数据聚合(需求/架构/数据库/代码/测试/版本历史),
 * 输出:结构化概览(UI 展示)+ 出题/评分用上下文文本。全部来源于真实项目数据。
 */

export interface KnowledgeOverview {
  project: { name: string; type: string; techStack: string[]; difficulty: string | null };
  counts: {
    roles: number;
    featureModules: number;
    techStacks: number;
    modules: number;
    apis: number;
    tables: number;
    relations: number;
    codeFiles: number;
    commits: number;
    testRuns: number;
    latestPassRate: number | null;
    docSections: number;
  };
  highlights: string[];
}

export async function buildKnowledgeOverview(
  projectId: string,
  userId: string,
): Promise<KnowledgeOverview> {
  const project = await db.project.findFirst({
    where: { id: projectId, userId },
    select: { name: true, type: true, techStack: true, difficulty: true },
  });
  if (!project) throw new Error("项目不存在或无权访问");

  const requirement = await db.requirement.findUnique({
    where: { projectId },
    select: { id: true },
  });
  const [roles, featureRoots, architecture, runs, commits, codeFileCount, docSections] =
    await Promise.all([
      requirement
        ? db.userRole.count({ where: { requirementId: requirement.id } })
        : Promise.resolve(0),
      requirement
        ? db.feature.count({ where: { requirementId: requirement.id, parentId: null } })
        : Promise.resolve(0),
      db.architecture.findFirst({
        where: { projectId },
        include: {
          techStacks: true,
          modules: true,
          apiDefinitions: true,
          database: { include: { tables: true, relations: true } },
        },
      }),
      db.testRun.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 5 }),
      listCommits(projectId, 100).catch(() => []),
      import("@/server/workspace/search").then(
        (m) => m.listProjectFilePaths(projectId, userId).length,
      ),
      db.documentSection.count({ where: { document: { projectId } } }),
    ]);

  const latestRun = runs[0];
  const highlights: string[] = [];
  if (architecture) {
    highlights.push(
      `技术栈 ${architecture.techStacks.length} 项:${architecture.techStacks
        .slice(0, 6)
        .map((t) => t.name)
        .join("、")}`,
    );
    highlights.push(
      `功能模块 ${architecture.modules.length} 个,API 规划 ${architecture.apiDefinitions.length} 个`,
    );
    if (architecture.database) {
      highlights.push(
        `数据库 ${architecture.database.engine} · ${architecture.database.tables.length} 张表 · ${architecture.database.relations.length} 组关系`,
      );
    }
  }
  if (latestRun) {
    highlights.push(`最近测试:${latestRun.passed}/${latestRun.total} 通过([${latestRun.kind}])`);
  }
  if (commits.length) {
    highlights.push(
      `版本历史 ${commits.length}+ 次提交,最近:${commits[0].message.split("\n")[0].slice(0, 40)}`,
    );
  }

  let techStackList: string[] = [];
  try {
    const parsed = JSON.parse(project.techStack) as unknown;
    techStackList = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    techStackList = [];
  }

  return {
    project: {
      name: project.name,
      type: project.type,
      techStack: techStackList,
      difficulty: project.difficulty,
    },
    counts: {
      roles,
      featureModules: featureRoots,
      techStacks: architecture?.techStacks.length ?? 0,
      modules: architecture?.modules.length ?? 0,
      apis: architecture?.apiDefinitions.length ?? 0,
      tables: architecture?.database?.tables.length ?? 0,
      relations: architecture?.database?.relations.length ?? 0,
      codeFiles: codeFileCount,
      commits: commits.length,
      testRuns: runs.length,
      latestPassRate:
        latestRun && latestRun.total > 0
          ? Math.round((latestRun.passed / latestRun.total) * 100)
          : null,
      docSections,
    },
    highlights,
  };
}

/** 出题/评分用的完整上下文文本(真实项目数据)。 */
export async function buildDefenseKnowledgeText(
  projectId: string,
  userId: string,
): Promise<string> {
  const { texts } = await buildDocumentContext(projectId, userId, [
    "project",
    "requirements",
    "architecture",
    "database",
    "tests",
    "git",
  ]);
  return joinContext(texts, [
    "project",
    "requirements",
    "architecture",
    "database",
    "tests",
    "git",
  ]);
}
