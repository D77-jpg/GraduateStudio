import { z } from "zod";
import { DIFFICULTIES, PROJECT_TYPES } from "@/lib/projects";
import { FEATURE_PRIORITIES } from "@/lib/requirements";

/**
 * AI 结构化输出 schema。
 * 约束:字段全部必填、不使用 nullable/递归,以兼容 OpenAI structured outputs(strict mode);
 * 空值一律用空字符串/空数组表达,入库时再归一化。
 */

export const topicProposalOutputSchema = z.object({
  name: z.string().min(2).describe("论文式项目名称,形如「基于 X 的 Y 设计与实现」"),
  summary: z.string().min(10).describe("项目简介,2-3 句话"),
  background: z.string().min(10).describe("项目背景,2-4 句话,说明现实痛点与研究意义"),
  goals: z.array(z.string().min(2)).min(3).max(5).describe("项目目标,3-5 条"),
  type: z.enum(PROJECT_TYPES).describe("项目类型"),
  techStack: z.array(z.string().min(1)).min(3).max(8).describe("推荐技术栈,4-8 项具体技术"),
  devLanguage: z.string().min(1).describe("主要开发语言,如 Java / Python / TypeScript"),
  database: z.string().min(1).describe("推荐数据库,如 MySQL / PostgreSQL"),
  difficulty: z.enum(DIFFICULTIES).describe("实现难度"),
  innovation: z.number().int().min(0).max(100).describe("创新性评分"),
  implementDifficulty: z.number().int().min(0).max(100).describe("实现难度评分,分数越高越难"),
  paperFriendliness: z.number().int().min(0).max(100).describe("论文友好度评分"),
  defense: z.number().int().min(0).max(100).describe("答辩展示度评分"),
  overall: z.number().int().min(0).max(100).describe("综合评分"),
});

export type TopicProposalOutput = z.infer<typeof topicProposalOutputSchema>;

export const featureOutputSchema = z.object({
  name: z.string().min(1).max(40).describe("功能名称,简短名词短语"),
  description: z.string().max(200).describe("功能描述,一句话,可为空字符串"),
  priority: z.enum(FEATURE_PRIORITIES).describe("优先级:must=核心 should=重要 could=可选"),
});

export const moduleOutputSchema = z.object({
  name: z.string().min(1).max(40).describe("功能模块名称,如「用户系统」"),
  description: z.string().max(200).describe("模块描述,可为空字符串"),
  priority: z.enum(FEATURE_PRIORITIES),
  features: z.array(featureOutputSchema).min(2).max(8).describe("该模块下的功能点"),
});

export const requirementOutputSchema = z.object({
  background: z.string().min(10).describe("项目背景,3-5 句话,面向论文的需求分析章节"),
  goals: z.array(z.string().min(2)).min(3).max(6).describe("项目目标,3-6 条"),
  roles: z
    .array(z.object({ name: z.string().min(1).max(30), description: z.string().max(200) }))
    .min(2)
    .max(5)
    .describe("用户角色,2-5 个"),
  modules: z
    .array(moduleOutputSchema)
    .min(4)
    .max(10)
    .describe("功能模块,4-10 个,每个含 2-8 个功能点"),
  flows: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        steps: z.array(z.string().min(1)).min(2).max(8),
      }),
    )
    .min(2)
    .max(6)
    .describe("核心业务流程,2-6 条,每条 2-8 个步骤"),
  nonFunctional: z
    .array(z.string().min(2))
    .min(3)
    .max(8)
    .describe("非功能需求,3-8 条(性能/安全/可用性等)"),
  boundaries: z.object({
    inScope: z.array(z.string().min(2)).min(2).max(6).describe("系统边界内:本次要做的内容"),
    outOfScope: z.array(z.string().min(2)).min(2).max(6).describe("系统边界外:明确不做的内容"),
  }),
  devTasks: z
    .array(z.object({ title: z.string().min(2).max(60), description: z.string().max(200) }))
    .min(4)
    .max(12)
    .describe("开发任务列表,按实现顺序排列,4-12 条"),
});

export type RequirementOutput = z.infer<typeof requirementOutputSchema>;

export const moduleFeaturesOutputSchema = z.object({
  features: z.array(featureOutputSchema).min(2).max(8).describe("该模块下的功能点"),
});

export type ModuleFeaturesOutput = z.infer<typeof moduleFeaturesOutputSchema>;
