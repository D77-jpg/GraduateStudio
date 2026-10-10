import { z } from "zod";

/**
 * 项目领域模型(前后端共享)。
 * 阶段顺序对应产品规划的毕业进度:选题 → 需求 → UI → 架构 → 数据库 → 开发 → 测试 → 文档 → 答辩 → 部署。
 */

export const PROJECT_STAGES = [
  "topic",
  "requirements",
  "design",
  "architecture",
  "database",
  "coding",
  "testing",
  "docs",
  "defense",
  "deploy",
] as const;

export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const STAGE_LABELS: Record<ProjectStage, string> = {
  topic: "选题",
  requirements: "需求分析",
  design: "UI 设计",
  architecture: "系统架构",
  database: "数据库",
  coding: "AI 开发",
  testing: "测试",
  docs: "文档",
  defense: "答辩",
  deploy: "部署",
};

/** 各阶段的落地页;未开放的阶段回落到项目概览。 */
export const STAGE_ROUTES: Partial<Record<ProjectStage, string>> = {
  topic: "/projects",
  requirements: "/projects/:id/requirements",
  architecture: "/projects/:id/architecture",
  database: "/projects/:id/database",
};

export const PROJECT_TYPES = [
  "web",
  "admin",
  "miniapp",
  "ai",
  "data",
  "app",
  "iot",
] as const;

export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  web: "Web 系统",
  admin: "管理系统",
  miniapp: "小程序",
  ai: "AI 应用",
  data: "数据分析",
  app: "APP",
  iot: "物联网",
};

export const DIFFICULTIES = ["entry", "simple", "medium", "hard", "advanced"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  entry: "⭐ 入门",
  simple: "⭐⭐ 简单",
  medium: "⭐⭐⭐ 中等",
  hard: "⭐⭐⭐⭐ 困难",
  advanced: "⭐⭐⭐⭐⭐ 高阶",
};

export const PROJECT_STATUSES = ["active", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "进行中",
  completed: "已完成",
  archived: "已归档",
};

/** AI 选题评分(0-100)。implementDifficulty 越低越容易实现。 */
export const topicScoresSchema = z.object({
  innovation: z.number().int().min(0).max(100),
  implementDifficulty: z.number().int().min(0).max(100),
  paperFriendliness: z.number().int().min(0).max(100),
  defense: z.number().int().min(0).max(100),
  overall: z.number().int().min(0).max(100),
});
export type TopicScores = z.infer<typeof topicScoresSchema>;

export const SCORE_LABELS: Record<keyof TopicScores, string> = {
  innovation: "创新性",
  implementDifficulty: "实现难度",
  paperFriendliness: "论文友好度",
  defense: "答辩展示度",
  overall: "综合评分",
};

export const projectDtoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  type: z.enum(PROJECT_TYPES),
  techStack: z.array(z.string()),
  stage: z.enum(PROJECT_STAGES),
  progress: z.number().int().min(0).max(100),
  status: z.enum(PROJECT_STATUSES),
  devLanguage: z.string().nullable(),
  database: z.string().nullable(),
  difficulty: z.enum(DIFFICULTIES).nullable(),
  needsAi: z.boolean(),
  background: z.string().nullable(),
  goals: z.array(z.string()),
  scores: topicScoresSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectDto = z.infer<typeof projectDtoSchema>;

/** 创建项目:手动表单与「采用 AI 选题方案」共用一个入口。 */
export const projectCreateSchema = z.object({
  name: z.string().trim().min(2, "项目名称至少 2 个字符").max(80, "项目名称过长"),
  description: z.string().trim().max(500, "项目描述过长").optional().default(""),
  type: z.enum(PROJECT_TYPES).default("web"),
  techStack: z.array(z.string().trim().min(1)).max(12).default([]),
  devLanguage: z.string().trim().max(40).optional().default(""),
  database: z.string().trim().max(40).optional().default(""),
  difficulty: z.enum(DIFFICULTIES).optional().nullable(),
  needsAi: z.boolean().default(false),
  background: z.string().trim().max(2000).optional().default(""),
  goals: z.array(z.string().trim().min(1)).max(10).default([]),
  scores: topicScoresSchema.optional().nullable(),
});

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

export function stageIndex(stage: ProjectStage): number {
  return PROJECT_STAGES.indexOf(stage);
}

/** 项目工作区各页面路由 */
export function projectRoute(projectId: string, path = ""): string {
  return `/projects/${projectId}${path}`;
}
