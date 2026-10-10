import { z } from "zod";

/**
 * 需求分析领域模型(前后端共享)。
 * AI 生成内容结构化存储:角色(UserRole 表)、功能树(Feature 表,两层),
 * 流程/非功能/边界/任务以 JSON 存储在 Requirement 行上。
 */

export const FEATURE_PRIORITIES = ["must", "should", "could"] as const;
export type FeaturePriority = (typeof FEATURE_PRIORITIES)[number];

export const FEATURE_PRIORITY_LABELS: Record<FeaturePriority, string> = {
  must: "核心",
  should: "重要",
  could: "可选",
};

export interface FeatureNodeDto {
  id: string;
  name: string;
  description: string;
  priority: FeaturePriority;
  order: number;
  children: FeatureNodeDto[];
}

export const featureInputSchema = z.object({
  name: z.string().trim().min(1, "功能名称不能为空").max(60, "功能名称过长"),
  description: z.string().trim().max(300, "功能描述过长").default(""),
  priority: z.enum(FEATURE_PRIORITIES).default("should"),
});

export const featureUpdateSchema = featureInputSchema.partial();

export const roleSchema = z.object({
  name: z.string().trim().min(1, "角色名称不能为空").max(40, "角色名称过长"),
  description: z.string().trim().max(300, "角色描述过长").default(""),
});

export const flowSchema = z.object({
  name: z.string(),
  steps: z.array(z.string()),
});

export const boundariesSchema = z.object({
  inScope: z.array(z.string()),
  outOfScope: z.array(z.string()),
});

export const devTaskSchema = z.object({
  title: z.string(),
  description: z.string().default(""),
});

export const requirementDtoSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  background: z.string().nullable(),
  goals: z.array(z.string()),
  roles: z.array(roleSchema),
  features: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      priority: z.enum(FEATURE_PRIORITIES),
      order: z.number().int(),
      children: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          priority: z.enum(FEATURE_PRIORITIES),
          order: z.number().int(),
        }),
      ),
    }),
  ),
  flows: z.array(flowSchema),
  nonFunctional: z.array(z.string()),
  boundaries: boundariesSchema,
  devTasks: z.array(devTaskSchema),
  updatedAt: z.string(),
});

export type RequirementDto = z.infer<typeof requirementDtoSchema>;

/** 需求元信息编辑(PATCH):整体替换对应字段,未传字段保持不变。 */
export const requirementUpdateSchema = z.object({
  background: z.string().max(2000).optional(),
  goals: z.array(z.string().trim().min(1)).max(10).optional(),
  roles: z.array(roleSchema).max(8).optional(),
  nonFunctional: z.array(z.string().trim().min(1)).max(12).optional(),
  boundaries: boundariesSchema.optional(),
});

export type RequirementUpdateInput = z.infer<typeof requirementUpdateSchema>;

/** 由扁平 Feature 行构建两层功能树(Phase 2 约定:模块 → 功能点)。 */
export function buildFeatureTree(
  rows: Array<{
    id: string;
    parentId: string | null;
    name: string;
    description: string;
    priority: string;
    order: number;
  }>,
): RequirementDto["features"] {
  const modules = rows
    .filter((row) => row.parentId === null)
    .sort((a, b) => a.order - b.order)
    .map((module) => ({
      id: module.id,
      name: module.name,
      description: module.description,
      priority: (module.priority as FeaturePriority) ?? "should",
      order: module.order,
      children: rows
        .filter((row) => row.parentId === module.id)
        .sort((a, b) => a.order - b.order)
        .map((child) => ({
          id: child.id,
          name: child.name,
          description: child.description,
          priority: (child.priority as FeaturePriority) ?? "should",
          order: child.order,
        })),
    }));
  return modules;
}
