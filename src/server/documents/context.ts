import { db } from "@/server/db";
import { buildProjectRequirementText } from "@/server/agents/context";
import { listProjectFilePaths, readFileOrNull } from "@/server/workspace/search";
import { listCommits } from "@/server/git";

/**
 * Phase 9:文档中心上下文聚合。
 * 按章节需要读取真实项目数据(需求/架构/数据库/代码/测试/版本历史),
 * 并产出依赖快照(sourceContext),用于"项目变化 → 文档需同步"检测。
 * 原则:AI 生成内容必须来源于这些真实数据,禁止编造。
 */

const MAX_CODE_FILES = 24;
const MAX_CODE_FILE_CHARS = 4_000;
const MAX_CODE_TOTAL_CHARS = 16_000;

export type DataSourceKind =
  "project" | "requirements" | "architecture" | "database" | "code" | "tests" | "git";

export interface DocContextInput {
  project: string;
  requirements: string;
  architecture: string;
  database: string;
  code: string;
  tests: string;
  git: string;
}

export interface DependencySnapshot {
  archUpdatedAt: string | null;
  /** 数据库签名(表名+字段数),无 updatedAt 字段用内容签名检测变化 */
  dbSignature: string | null;
  latestCommitHash: string | null;
  latestTestRunAt: string | null;
  codeFiles: string[];
  capturedAt: string;
}

/** 需要哪些数据源的章节 → 聚合文本(依赖快照总是独立采集,供同步检测)。 */
export async function buildDocumentContext(
  projectId: string,
  userId: string,
  kinds: DataSourceKind[],
): Promise<{ texts: Partial<DocContextInput>; snapshot: DependencySnapshot }> {
  const want = new Set(kinds);
  const texts: Partial<DocContextInput> = {};

  // 依赖快照:与章节所需数据源无关,总是采集(本地 SQLite/单条 git log,成本极低)
  const [archRow, lastRun, commits] = await Promise.all([
    db.architecture.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      select: {
        updatedAt: true,
        database: {
          select: {
            tables: {
              orderBy: { order: "asc" },
              select: { name: true, _count: { select: { fields: true } } },
            },
          },
        },
      },
    }),
    db.testRun.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    listCommits(projectId, 1).catch(() => []),
  ]);
  const dbSignature = archRow?.database
    ? archRow.database.tables.map((t) => `${t.name}:${t._count.fields}`).join(",")
    : null;
  const snapshot: DependencySnapshot = {
    archUpdatedAt: archRow?.updatedAt.toISOString() ?? null,
    dbSignature,
    latestCommitHash: commits[0]?.hash ?? null,
    latestTestRunAt: lastRun?.createdAt.toISOString() ?? null,
    codeFiles: listProjectFilePaths(projectId, userId).slice(0, 200),
    capturedAt: new Date().toISOString(),
  };

  if (want.has("project") || want.has("requirements")) {
    const { projectText, requirementText } = await buildProjectRequirementText(projectId, userId);
    if (want.has("project")) texts.project = projectText;
    if (want.has("requirements")) texts.requirements = requirementText;
  }

  // 架构 + 数据库(Phase 3 产出)
  const architecture = await db.architecture.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: {
      techStacks: true,
      modules: true,
      apiDefinitions: true,
      database: {
        include: {
          tables: { orderBy: { order: "asc" }, include: { fields: { orderBy: { order: "asc" } } } },
          relations: true,
        },
      },
    },
  });

  if (want.has("architecture") || want.has("database")) {
    if (architecture) {
      if (want.has("architecture")) {
        texts.architecture = [
          `架构总览:${architecture.summary}`,
          `前端架构:${architecture.frontendArch}`,
          `后端架构:${architecture.backendArch}`,
          "",
          "技术栈:",
          ...architecture.techStacks.map((t) => `- [${t.layer}] ${t.name}:${t.reason}`),
          "",
          "系统模块:",
          ...architecture.modules.map((m) => `- ${m.name}(${m.layer}):${m.description}`),
          "",
          "API 规划:",
          ...architecture.apiDefinitions.map((a) => `- ${a.method} ${a.path}:${a.summary}`),
          "",
          "目录结构:",
          architecture.directoryTree,
        ].join("\n");
      }
      if (want.has("database") && architecture.database) {
        const db = architecture.database;
        texts.database = [
          `数据库引擎:${db.engine}`,
          "",
          "数据表:",
          ...db.tables.map(
            (t) =>
              `- ${t.name}${t.description ? `(${t.description})` : ""}:\n` +
              t.fields
                .map(
                  (f) =>
                    `    ${f.name} ${f.type}${f.isPrimary ? " 主键" : ""}${f.isUnique ? " 唯一" : ""}${f.nullable ? "" : " 非空"}${f.description ? ` // ${f.description}` : ""}`,
                )
                .join("\n"),
          ),
          "",
          "表关系:",
          ...db.relations.map(
            (r) => `- ${r.fromTable}.${r.fromField} → ${r.toTable}.${r.toField}(${r.kind})`,
          ),
        ].join("\n");
      }
    } else {
      if (want.has("architecture")) texts.architecture = "(系统架构尚未生成)";
      if (want.has("database")) texts.database = "(数据库设计尚未生成)";
    }
  }

  // 代码:文件树 + 关键源文件内容(优先 src 下源码,预算裁剪)
  if (want.has("code") || want.has("git")) {
    const allPaths = listProjectFilePaths(projectId, userId);
    if (want.has("code")) {
      const sourcePaths = allPaths
        .filter((p) => /\.(js|jsx|ts|tsx|vue|py|java|go|css|sql)$/.test(p))
        .filter((p) => !/node_modules|package-lock|\.min\./.test(p))
        .slice(0, 200);
      // 优先取业务代码(api/services/routes/views/components 等路径特征),再补其余
      const prioritized = [
        ...sourcePaths.filter((p) =>
          /src|api|service|controller|route|view|component|store|utils/i.test(p),
        ),
        ...sourcePaths.filter(
          (p) => !/src|api|service|controller|route|view|component|store|utils/i.test(p),
        ),
      ].slice(0, MAX_CODE_FILES);
      let remaining = MAX_CODE_TOTAL_CHARS;
      const chunks: string[] = [];
      for (const p of prioritized) {
        if (remaining <= 0) break;
        const content = readFileOrNull(projectId, userId, p);
        if (content === null) continue;
        const clipped = content.slice(0, Math.min(MAX_CODE_FILE_CHARS, remaining));
        remaining -= clipped.length;
        chunks.push(
          `--- ${p} ---\n${clipped}${clipped.length < content.length ? "\n…(截断)" : ""}`,
        );
      }
      texts.code = [
        `文件树(${allPaths.length} 个文件):`,
        ...allPaths.slice(0, 80).map((p) => `- ${p}`),
        "",
        "关键源码:",
        ...chunks,
      ].join("\n");
    }
  }

  // 测试:最近 TestRun + 结果 + 失败分析
  if (want.has("tests")) {
    const runs = await db.testRun.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { results: { where: { status: "failed" }, take: 5 } },
    });
    if (runs.length) {
      texts.tests = [
        ...runs.map(
          (r) =>
            `- ${r.createdAt.toISOString().slice(0, 16)} [${r.kind}] ${r.status} · 通过 ${r.passed}/${r.total},失败 ${r.failed}` +
            (r.failed > 0 && r.results.length
              ? `\n  失败用例:${r.results
                  .slice(0, 3)
                  .map((x) => x.name)
                  .join("; ")}`
              : ""),
        ),
      ].join("\n");
    } else {
      texts.tests = "(尚未运行过测试)";
    }
  }

  // 版本历史(git log)
  if (want.has("git")) {
    try {
      const commits = await listCommits(projectId, 15);
      if (commits.length) {
        texts.git = commits
          .map((c) => `- ${c.shortHash} ${c.date.slice(0, 10)} ${c.message.split("\n")[0]}`)
          .join("\n");
      } else {
        texts.git = "(仓库还没有提交)";
      }
    } catch {
      texts.git = "(仓库尚未初始化)";
    }
  }

  return { texts, snapshot };
}

/** 章节源文本由数据源列表拼装。 */
export function joinContext(texts: Partial<DocContextInput>, kinds: DataSourceKind[]): string {
  const labels: Record<DataSourceKind, string> = {
    project: "项目信息",
    requirements: "需求分析",
    architecture: "系统架构",
    database: "数据库设计",
    code: "代码(真实源码摘录)",
    tests: "测试记录",
    git: "版本历史",
  };
  return kinds.map((k) => `## ${labels[k]}\n${texts[k] ?? "(无数据)"}`).join("\n\n");
}
