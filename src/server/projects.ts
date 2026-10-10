import { db } from "@/server/db";
import type { Project } from "@prisma/client";
import {
  projectDtoSchema,
  topicScoresSchema,
  type ProjectCreateInput,
  type ProjectDto,
} from "@/lib/projects";

/**
 * 项目服务层:UI 一律通过 DTO(ProjectDto)访问项目数据,
 * 后续阶段扩展字段或更换存储时,只需要保持 DTO 兼容。
 */

function parseJsonArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // 忽略脏数据,返回空数组
  }
  return [];
}

function parseScores(raw: string | null): ProjectDto["scores"] {
  if (!raw) return null;
  const parsed = topicScoresSchema.safeParse(safeJsonParse(raw));
  return parsed.success ? parsed.data : null;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function toProjectDto(row: Project): ProjectDto {
  return projectDtoSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    techStack: parseJsonArray(row.techStack),
    stage: row.stage,
    progress: row.progress,
    status: row.status,
    devLanguage: row.devLanguage,
    database: row.database,
    difficulty: row.difficulty,
    needsAi: row.needsAi,
    background: row.background,
    goals: parseJsonArray(row.goals),
    scores: parseScores(row.scores),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function listProjectsByUser(userId: string): Promise<ProjectDto[]> {
  const rows = await db.project.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(toProjectDto);
}

export async function getProjectById(
  projectId: string,
  userId: string,
): Promise<ProjectDto | null> {
  const row = await db.project.findFirst({
    where: { id: projectId, userId },
  });
  return row ? toProjectDto(row) : null;
}

/** 创建项目:手动表单与「采用 AI 选题方案」共用;选题方案带来的背景/目标/评分一并落库。 */
export async function createProject(
  userId: string,
  input: ProjectCreateInput,
): Promise<ProjectDto> {
  const row = await db.project.create({
    data: {
      userId,
      name: input.name,
      description: input.description || null,
      type: input.type,
      techStack: JSON.stringify(input.techStack),
      devLanguage: input.devLanguage || null,
      database: input.database || null,
      difficulty: input.difficulty ?? null,
      needsAi: input.needsAi,
      background: input.background || null,
      goals: JSON.stringify(input.goals),
      scores: input.scores ? JSON.stringify(input.scores) : null,
      stage: "topic",
      progress: input.scores ? 10 : 5,
    },
  });
  return toProjectDto(row);
}
