import { z } from "zod";

/** 项目领域模型(前后端共享)。阶段键保持兼容已有数据，只统一产品顺序与展示。 */
export const PROJECT_STAGES = [
  "topic",
  "requirements",
  "architecture",
  "design",
  "database",
  "coding",
  "testing",
  "deploy",
  "docs",
  "defense",
] as const;

export type ProjectStage = (typeof PROJECT_STAGES)[number];

/** 唯一的阶段元数据源。界面设计复用开发工作区，不创建不存在的 design 路由。 */
export const STAGE_METADATA = {
  topic: {
    label: "选题规划",
    description: "明确研究方向、项目背景与毕业设计目标。",
    route: "/projects/:id",
  },
  requirements: {
    label: "需求分析",
    description: "梳理用户角色、功能模块与业务流程。",
    route: "/projects/:id/requirements",
  },
  architecture: {
    label: "架构设计",
    description: "确定系统分层、技术选型与模块协作。",
    route: "/projects/:id/architecture",
  },
  design: {
    label: "界面设计",
    description: "在开发工作区构建页面结构与交互界面。",
    route: "/projects/:id/develop?stage=design",
  },
  database: {
    label: "数据库设计",
    description: "设计实体关系、数据表与存储约束。",
    route: "/projects/:id/database",
  },
  coding: {
    label: "AI 开发",
    description: "与 AI 协作编写代码，实现核心功能。",
    route: "/projects/:id/develop",
  },
  testing: {
    label: "测试验证",
    description: "验证功能、定位问题并完善测试覆盖。",
    route: "/projects/:id/tests",
  },
  deploy: {
    label: "部署交付",
    description: "配置部署环境，整理可运行的交付成果。",
    route: "/projects/:id/deploy",
  },
  docs: {
    label: "毕设文档",
    description: "沉淀实现过程，编写论文与项目文档。",
    route: "/projects/:id/docs",
  },
  defense: {
    label: "答辩准备",
    description: "准备演示材料、答辩讲稿与问题练习。",
    route: "/projects/:id/defense",
  },
} satisfies Record<ProjectStage, { label: string; description: string; route: string }>;

export const STAGE_LABELS = Object.fromEntries(
  PROJECT_STAGES.map((stage) => [stage, STAGE_METADATA[stage].label]),
) as Record<ProjectStage, string>;

export const STAGE_ROUTES = Object.fromEntries(
  PROJECT_STAGES.map((stage) => [stage, STAGE_METADATA[stage].route]),
) as Record<ProjectStage, string>;

export function stageRoute(projectId: string, stage: ProjectStage): string {
  return STAGE_METADATA[stage].route.replace(":id", encodeURIComponent(projectId));
}

/** 辅助工具贯穿多个阶段，不计入毕业设计阶段。 */
export const PROJECT_TOOLS = [
  { key: "agent", label: "自主开发", description: "让 Agent 执行多步开发任务。", path: "/agent" },
  {
    key: "run",
    label: "运行与预览",
    description: "启动项目，检查运行环境与页面效果。",
    path: "/run",
  },
  { key: "git", label: "版本控制", description: "查看代码变更，管理项目版本。", path: "/git" },
] as const;

/** 从真实路由识别阶段；设计与开发共享工作区，通过 query 区分。 */
export function stageFromPath(
  projectId: string,
  pathname: string,
  designMode = false,
): ProjectStage | undefined {
  if (pathname === projectRoute(projectId, "/develop")) return designMode ? "design" : "coding";
  return PROJECT_STAGES.find((stage) => stageRoute(projectId, stage).split("?")[0] === pathname);
}

export const PROJECT_TYPES = ["web", "admin", "miniapp", "ai", "data", "app", "iot"] as const;

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
