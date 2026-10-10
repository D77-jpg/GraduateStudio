import { db } from "@/server/db";
import type { Feature, Prisma } from "@prisma/client";
import {
  buildFeatureTree,
  requirementDtoSchema,
  type RequirementDto,
  type RequirementUpdateInput,
  type FeaturePriority,
} from "@/lib/requirements";
import type { RequirementOutput } from "@/server/ai/schemas";

/**
 * 需求服务:AI 生成结果的落库、读取(功能树组装)、手动编辑(角色/背景/目标/非功能/边界)、
 * 功能点 CRUD、单模块重新生成。所有操作校验项目归属。
 */

export class RequirementAccessError extends Error {}
export class RequirementConflictError extends Error {}

async function assertProjectOwner(projectId: string, userId: string): Promise<void> {
  const project = await db.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!project) throw new RequirementAccessError("项目不存在或无权访问");
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function getRequirementByProject(
  projectId: string,
  userId: string,
): Promise<RequirementDto | null> {
  await assertProjectOwner(projectId, userId);

  const requirement = await db.requirement.findUnique({
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
  if (!requirement) return null;

  const roles = await db.userRole.findMany({
    where: { requirementId: requirement.id },
    orderBy: { order: "asc" },
  });

  return requirementDtoSchema.parse({
    id: requirement.id,
    projectId: requirement.projectId,
    background: requirement.background,
    goals: parseJson<string[]>(requirement.goals, []),
    roles: roles.map((role) => ({ name: role.name, description: role.description })),
    features: buildFeatureTree(requirement.features),
    flows: parseJson<RequirementDto["flows"]>(requirement.businessFlows, []),
    nonFunctional: parseJson<string[]>(requirement.nonFunctional, []),
    boundaries: parseJson<RequirementDto["boundaries"]>(requirement.boundaries, {
      inScope: [],
      outOfScope: [],
    }),
    devTasks: parseJson<RequirementDto["devTasks"]>(requirement.devTasks, []),
    updatedAt: requirement.updatedAt.toISOString(),
  });
}

/** 将 AI 需求分析输出整体落库(覆盖式:删除旧角色/功能后插入),并推进项目阶段。 */
export async function replaceRequirementFromDraft(
  projectId: string,
  userId: string,
  draft: RequirementOutput,
): Promise<RequirementDto> {
  await assertProjectOwner(projectId, userId);

  await db.$transaction(async (tx) => {
    const existing = await tx.requirement.findUnique({
      where: { projectId },
      select: { id: true },
    });

    if (existing) {
      await tx.feature.deleteMany({ where: { requirementId: existing.id } });
      await tx.userRole.deleteMany({ where: { requirementId: existing.id } });
      await tx.requirement.delete({ where: { id: existing.id } });
    }

    const requirement = await tx.requirement.create({
      data: {
        projectId,
        background: draft.background,
        goals: JSON.stringify(draft.goals),
        businessFlows: JSON.stringify(draft.flows),
        nonFunctional: JSON.stringify(draft.nonFunctional),
        boundaries: JSON.stringify(draft.boundaries),
        devTasks: JSON.stringify(draft.devTasks),
      },
    });

    await tx.userRole.createMany({
      data: draft.roles.map((role, index) => ({
        requirementId: requirement.id,
        name: role.name,
        description: role.description ?? "",
        order: index,
      })),
    });

    for (const [moduleIndex, module] of draft.modules.entries()) {
      const parent = await tx.feature.create({
        data: {
          requirementId: requirement.id,
          name: module.name,
          description: module.description ?? "",
          priority: module.priority ?? "should",
          order: moduleIndex,
        },
      });
      await tx.feature.createMany({
        data: module.features.map((feature, featureIndex) => ({
          requirementId: requirement.id,
          parentId: parent.id,
          name: feature.name,
          description: feature.description ?? "",
          priority: feature.priority ?? "should",
          order: featureIndex,
        })),
      });
    }
  });

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { progress: true },
  });
  await db.project.update({
    where: { id: projectId },
    data: {
      stage: "requirements",
      progress: Math.max(project?.progress ?? 0, 25),
    },
  });

  const dto = await getRequirementByProject(projectId, userId);
  if (!dto) throw new Error("需求落库后读取失败");
  return dto;
}

/** 需求元信息编辑:整体替换传入的字段(角色/目标/非功能/边界)。 */
export async function updateRequirement(
  projectId: string,
  userId: string,
  input: RequirementUpdateInput,
): Promise<RequirementDto> {
  await assertProjectOwner(projectId, userId);

  const requirement = await db.requirement.findUnique({
    where: { projectId },
    select: { id: true },
  });
  if (!requirement) throw new RequirementConflictError("尚未生成需求分析");

  await db.$transaction(async (tx) => {
    const data: Prisma.RequirementUpdateInput = {};
    if (input.background !== undefined) data.background = input.background;
    if (input.goals !== undefined) data.goals = JSON.stringify(input.goals);
    if (input.nonFunctional !== undefined) {
      data.nonFunctional = JSON.stringify(input.nonFunctional);
    }
    if (input.boundaries !== undefined) {
      data.boundaries = JSON.stringify(input.boundaries);
    }
    if (Object.keys(data).length > 0) {
      await tx.requirement.update({ where: { id: requirement.id }, data });
    }

    if (input.roles !== undefined) {
      await tx.userRole.deleteMany({ where: { requirementId: requirement.id } });
      if (input.roles.length > 0) {
        await tx.userRole.createMany({
          data: input.roles.map((role, index) => ({
            requirementId: requirement.id,
            name: role.name,
            description: role.description ?? "",
            order: index,
          })),
        });
      }
    }
  });

  const dto = await getRequirementByProject(projectId, userId);
  if (!dto) throw new Error("需求读取失败");
  return dto;
}

async function loadOwnedFeature(
  featureId: string,
  projectId: string,
  userId: string,
): Promise<Feature> {
  const feature = await db.feature.findFirst({
    where: {
      id: featureId,
      requirement: { projectId, project: { userId } },
    },
  });
  if (!feature) throw new RequirementAccessError("功能不存在或无权访问");
  return feature;
}

export async function addFeature(
  projectId: string,
  userId: string,
  input: { parentId?: string | null; name: string; description: string; priority: FeaturePriority },
): Promise<void> {
  await assertProjectOwner(projectId, userId);

  let parentId: string | null = null;
  if (input.parentId) {
    const parent = await loadOwnedFeature(input.parentId, projectId, userId);
    if (parent.parentId !== null) {
      throw new RequirementConflictError("Phase 2 功能树只支持两层:功能点下不能再添加子功能");
    }
    parentId = parent.id;
  }

  const requirement = await db.requirement.findUnique({
    where: { projectId },
    select: { id: true },
  });
  if (!requirement) throw new RequirementConflictError("尚未生成需求分析");

  const last = await db.feature.findFirst({
    where: { requirementId: requirement.id, parentId: parentId ?? null },
    orderBy: { order: "desc" },
    select: { order: true },
  });

  await db.feature.create({
    data: {
      requirementId: requirement.id,
      parentId,
      name: input.name,
      description: input.description,
      priority: input.priority,
      order: (last?.order ?? -1) + 1,
    },
  });
}

export async function updateFeature(
  projectId: string,
  userId: string,
  featureId: string,
  input: { name?: string; description?: string; priority?: FeaturePriority },
): Promise<void> {
  await loadOwnedFeature(featureId, projectId, userId);
  await db.feature.update({
    where: { id: featureId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    },
  });
}

export async function deleteFeature(
  projectId: string,
  userId: string,
  featureId: string,
): Promise<void> {
  const feature = await loadOwnedFeature(featureId, projectId, userId);
  await db.$transaction(async (tx) => {
    await tx.feature.deleteMany({ where: { parentId: feature.id } });
    await tx.feature.delete({ where: { id: feature.id } });
  });
}

/** 单模块重新生成:用 AI 输出的功能点替换该模块的子节点。 */
export async function replaceModuleFeatures(
  projectId: string,
  userId: string,
  moduleId: string,
  features: Array<{ name: string; description: string; priority: FeaturePriority }>,
): Promise<void> {
  const featureModule = await loadOwnedFeature(moduleId, projectId, userId);
  if (featureModule.parentId !== null) {
    throw new RequirementConflictError("只能对顶层功能模块重新生成");
  }

  await db.$transaction(async (tx) => {
    await tx.feature.deleteMany({ where: { parentId: featureModule.id } });
    await tx.feature.createMany({
      data: features.map((feature, index) => ({
        requirementId: featureModule.requirementId,
        parentId: featureModule.id,
        name: feature.name,
        description: feature.description,
        priority: feature.priority,
        order: index,
      })),
    });
  });
}

export async function getFeatureWithSiblings(
  projectId: string,
  userId: string,
  moduleId: string,
): Promise<{ featureModule: Feature; siblings: string[] }> {
  const featureModule = await loadOwnedFeature(moduleId, projectId, userId);
  const siblings = await db.feature.findMany({
    where: {
      requirementId: featureModule.requirementId,
      parentId: null,
      id: { not: featureModule.id },
    },
    select: { name: true },
  });
  return { featureModule, siblings: siblings.map((s) => s.name) };
}
