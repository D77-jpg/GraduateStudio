import { generateObjectCompat } from "@/server/ai/compat";
import { z } from "zod";
import { TECH_LAYERS, MODULE_LAYERS, API_METHODS, RELATION_KINDS } from "@/lib/architecture";

/**
 * Architect Agent:根据 Project + Requirements 生成可执行的软件架构。
 * 全量生成产出草稿;数据库设计支持局部重新生成(不触碰其他已确认部分)。
 */

const GENERATE_TIMEOUT_MS = 480_000;
// deepseek-flash 开启 thinking 时推理与正文共享额度；架构 JSON 较长，12k 会被推理吃光。
const MAX_OUTPUT_TOKENS = 32_000;

export class ArchitectAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchitectAgentError";
  }
}

const SYSTEM = `你是资深的软件架构师,面向中国本科计算机毕业设计输出可落地的系统架构。
要求:
1. 只输出符合给定 JSON Schema 的内容;所有文本使用简体中文。
2. 技术选型贴合项目技术栈与学生能力,避免过度设计;给出真实理由(不写空话)。
3. API 采用 REST 风格,路径以 /api/ 开头;每个 API 有明确的所属模块与是否需要登录。
4. 权限设计覆盖需求中的所有用户角色;action 使用 list/create/read/update/delete/audit 等。
5. 数据库表设计规范:每表都有自增或雪花 id 主键、created_at/updated_at 时间戳字段;外键字段命名为 xxx_id;
   字段类型使用具体 SQL 类型(如 BIGINT / VARCHAR(255) / TEXT / DECIMAL(10,2) / DATETIME / BOOLEAN);
   索引描述如「idx: user_id」或「uniq: username」;表关系必须与外键一致且可实施。`;

const databaseSchemaShape = {
  engine: z.string().min(1).max(40).describe("数据库引擎,如 MySQL 8.0"),
  tables: z
    .array(
      z.object({
        name: z.string().min(2).max(60).describe("表名,snake_case 复数形式,如 users"),
        description: z.string().max(200).describe("表用途,一句话"),
        indexes: z.array(z.string().max(60)).max(6).describe("索引列表,可为空数组"),
        fields: z
          .array(
            z.object({
              name: z.string().min(1).max(60).describe("字段名,snake_case"),
              type: z.string().min(1).max(40).describe("SQL 类型"),
              nullable: z.boolean(),
              isPrimary: z.boolean(),
              isUnique: z.boolean(),
              defaultValue: z.string().max(60).describe("默认值,无则空字符串"),
              description: z.string().max(120).describe("字段说明"),
            }),
          )
          .min(3)
          .max(16),
      }),
    )
    .min(4)
    .max(12),
  relations: z
    .array(
      z.object({
        fromTable: z.string().min(1),
        fromField: z.string().min(1),
        toTable: z.string().min(1),
        toField: z.string().min(1),
        kind: z.enum(RELATION_KINDS).describe("one-to-many: from 的多条对应 to 的一条"),
      }),
    )
    .min(2)
    .max(14),
} as const;

export const architectureOverviewOutputSchema = z.object({
  summary: z
    .string()
    .min(20)
    .max(1500)
    .describe("系统架构总览,3-6 句话:整体形态、分层、关键设计决策"),
  frontendArch: z
    .string()
    .min(10)
    .max(800)
    .describe("前端架构说明:框架、路由/页面结构、状态管理、请求层"),
  backendArch: z
    .string()
    .min(10)
    .max(800)
    .describe("后端架构说明:框架、分层(controller/service/dao)、鉴权、事务"),
  rationale: z.string().min(20).max(1200).describe("技术选型理由:逐项说明为什么选它(毕业设计视角)"),
  directoryTree: z
    .string()
    .min(20)
    .max(2000)
    .describe("项目目录结构,用缩进文本树表示,含前后端关键目录"),
  techStack: z
    .array(
      z.object({
        layer: z.enum(TECH_LAYERS),
        name: z.string().min(1).max(60),
        reason: z.string().min(2).max(200).describe("选择理由,一句话"),
      }),
    )
    .min(5)
    .max(14),
  modules: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        description: z.string().min(2).max(200),
        layer: z.enum(MODULE_LAYERS),
      }),
    )
    .min(4)
    .max(10),
  apis: z
    .array(
      z.object({
        method: z.enum(API_METHODS),
        path: z.string().min(1).max(120).describe("以 /api/ 开头"),
        module: z.string().min(1).max(40).describe("所属功能模块名"),
        summary: z.string().min(2).max(120),
        requiresAuth: z.boolean().describe("是否需要登录;管理员接口也需要"),
      }),
    )
    .min(6)
    .max(24),
  permissions: z
    .array(
      z.object({
        role: z.string().min(1).max(30).describe("角色,与需求分析中的角色对应"),
        resource: z.string().min(1).max(40).describe("资源,如 products / orders / users"),
        action: z.string().min(1).max(30).describe("动作,如 create / update / delete / audit"),
        note: z.string().max(150).describe("说明,可为空字符串"),
      }),
    )
    .min(2)
    .max(12),
});

export type ArchitectureOverviewOutput = z.infer<typeof architectureOverviewOutputSchema>;

export const databaseOnlyOutputSchema = z.object(databaseSchemaShape);
export type DatabaseOnlyOutput = z.infer<typeof databaseOnlyOutputSchema>;

export function generateArchitectureOverview(input: {
  projectText: string;
  requirementText: string;
}): Promise<ArchitectureOverviewOutput> {
  return generateObjectCompat({
    system: SYSTEM,
    prompt: `请为以下毕业设计项目设计系统架构(暂不包含数据库设计,后续单独生成)。

${input.projectText}

## 需求分析(架构必须覆盖这些功能)
${input.requirementText}

要求:
1. 功能模块要与需求分析中的功能模块对应,并补充必要的支撑模块(如认证、文件上传)。
2. API 规划要覆盖每个功能模块的核心操作,粒度适中(不必罗列每个 CRUD 组合)。
3. 目录结构要能直接指导开发。
4. 硬性数量上限(超过会让结构化校验直接失败,必须合并同类项):技术栈 5-14 项;功能模块 4-10 个;API 6-24 条(同类 CRUD 合并成一条,如「/api/products 增删改查」只列 CRUD 中真正需要的 2-3 条);权限 2-12 条。`,
    schema: architectureOverviewOutputSchema,
    schemaName: "ArchitectureOverview",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
}

export function generateDatabaseSchema(input: {
  projectText: string;
  requirementText: string;
  architectureSummary: string;
  existingTableNames: string[];
}): Promise<DatabaseOnlyOutput> {
  return generateObjectCompat({
    system: SYSTEM,
    prompt: `请为以下毕业设计项目重新设计数据库(仅数据库部分,其他架构内容保持不变)。

${input.projectText}

## 需求分析
${input.requirementText}

## 当前架构摘要
${input.architectureSummary}

${input.existingTableNames.length ? `原表名(供参考,可调整):${input.existingTableNames.join("、")}` : ""}

要求:输出完整的数据库设计(表、字段、索引、关系),要支撑全部需求功能。
硬性数量上限(超过会让结构化校验直接失败):表 4-12 张(需求里已列出 12 张核心表时不要额外增加辅助表,合并到主表或省略);每张表字段 3-16 个;每表索引不超过 6 个;表间关系 2-14 条。`,
    schema: databaseOnlyOutputSchema,
    schemaName: "DatabaseSchema",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
}
