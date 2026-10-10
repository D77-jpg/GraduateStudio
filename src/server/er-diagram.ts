import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getArchitecture } from "@/server/architecture";
import type { ArchitectureDto } from "@/lib/architecture";

/**
 * sql2er 集成:把项目已确认的数据库设计转成 Chen 模型 ER 图(SQL DDL → sql2er CLI → SVG)。
 * 流水线:generate(--comment,中文属性) → relabel 实体为表名 → attrs moderate → export svg。
 * 结果按「项目 + 架构更新时间」缓存,架构未变时不重复生成。
 */

const execFileAsync = promisify(execFile);

export class ErDiagramError extends Error {
  code: string;
  constructor(message: string, code = "er_generation_failed") {
    super(message);
    this.name = "ErDiagramError";
    this.code = code;
  }
}

const cache = new Map<string, { svg: string; generatedAt: string }>();

function agentPath(): string | null {
  const p = process.env.SQL2ER_AGENT?.trim();
  return p && fs.existsSync(p) ? p : null;
}

/** 由数据库设计构建 MySQL DDL(列注释承载中文业务含义,供 sql2er --comment 使用)。 */
export function buildDdl(db: NonNullable<ArchitectureDto["database"]>): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  const lines: string[] = [];
  for (const table of db.tables) {
    lines.push(`CREATE TABLE ${table.name} (`);
    const cols = table.fields.map((f) => {
      let c = `  ${f.name} ${f.type}`;
      if (f.isPrimary) c += " PRIMARY KEY";
      if (f.isUnique && !f.isPrimary) c += " UNIQUE";
      if (!f.nullable && !f.isPrimary) c += " NOT NULL";
      if (f.description) c += ` COMMENT '${esc(f.description)}'`;
      return c;
    });
    lines.push(cols.join(",\n"));
    lines.push(") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;");
    lines.push("");
  }
  for (const r of db.relations) {
    lines.push(
      `ALTER TABLE ${r.fromTable} ADD FOREIGN KEY (${r.fromField}) REFERENCES ${r.toTable}(${r.toField});`,
    );
  }
  return lines.join("\n");
}

async function runAgent(agent: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [agent, ...args], {
      cwd,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new ErDiagramError(
      `sql2er 执行失败:${(err.stderr || err.message || "未知错误").slice(0, 300)}`,
    );
  }
}

/** 生成 Chen 模型 ER 图 SVG。architecture 传 null 表示项目尚无架构。 */
export async function generateErDiagramSvg(
  projectId: string,
  userId: string,
): Promise<{ svg: string; generatedAt: string } | null> {
  const architecture = await getArchitecture(projectId, userId);
  if (!architecture?.database || architecture.database.tables.length === 0) {
    return null;
  }

  const cacheKey = `${projectId}:${architecture.updatedAt}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const agent = agentPath();
  if (!agent) {
    throw new ErDiagramError(
      "未配置 sql2er CLI(请在 .env 设置 SQL2ER_AGENT 指向 sql2er-agent.mjs)",
      "er_not_configured",
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gs-er-"));
  try {
    const ddlPath = path.join(tmp, "schema.sql");
    const svgPath = path.join(tmp, "er.svg");
    fs.writeFileSync(ddlPath, buildDdl(architecture.database), "utf8");

    await runAgent(
      agent,
      ["generate", "--input", "schema.sql", "--state", "er.json", "--comment"],
      tmp,
    );

    // 实体标签:--comment 会用长句表注释作标题,统一改回表名(大写)
    const describeOut = await runAgent(agent, ["describe", "--state", "er.json"], tmp);
    const idRe = /entity-([A-Za-z0-9_]+)-\d+/g;
    const idToTable: Record<string, string> = {};
    for (const match of describeOut.matchAll(idRe)) {
      const [full, tableName] = match;
      if (!idToTable[full]) idToTable[full] = tableName.toUpperCase();
    }
    if (Object.keys(idToTable).length > 0) {
      await runAgent(
        agent,
        ["labels", "batch", "--text", JSON.stringify(idToTable), "--state", "er.json"],
        tmp,
      );
      await runAgent(agent, ["attrs", "moderate", "--state", "er.json"], tmp);
    }

    await runAgent(agent, ["export", "svg", "--out", "er.svg", "--state", "er.json"], tmp);
    const svg = fs.readFileSync(svgPath, "utf8");

    const result = { svg, generatedAt: new Date().toISOString() };
    cache.set(cacheKey, result);
    // 防缓存无限增长:同项目只保留最新 3 个版本
    const projectKeys = [...cache.keys()].filter((k) => k.startsWith(`${projectId}:`));
    if (projectKeys.length > 3) {
      const oldest = projectKeys.sort()[0];
      cache.delete(oldest);
    }
    return result;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
