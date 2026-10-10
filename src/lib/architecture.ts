import { z } from "zod";

/** 架构领域模型(前后端共享)。Phase 3:AI 生成草稿 → 用户确认;确认后不被自动覆盖。 */

export const ARCHITECTURE_STATUSES = ["draft", "confirmed"] as const;
export type ArchitectureStatus = (typeof ARCHITECTURE_STATUSES)[number];

export const ARCHITECTURE_STATUS_LABELS: Record<ArchitectureStatus, string> = {
  draft: "AI 建议草稿",
  confirmed: "已确认",
};

export const TECH_LAYERS = [
  "frontend",
  "backend",
  "database",
  "cache",
  "auth",
  "storage",
  "infra",
] as const;
export type TechLayer = (typeof TECH_LAYERS)[number];

export const TECH_LAYER_LABELS: Record<TechLayer, string> = {
  frontend: "前端",
  backend: "后端",
  database: "数据库",
  cache: "缓存",
  auth: "认证",
  storage: "存储",
  infra: "基础设施",
};

export const MODULE_LAYERS = ["frontend", "backend", "both"] as const;
export type ModuleLayer = (typeof MODULE_LAYERS)[number];

export const MODULE_LAYER_LABELS: Record<ModuleLayer, string> = {
  frontend: "前端",
  backend: "后端",
  both: "全栈",
};

export const API_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;
export type ApiMethod = (typeof API_METHODS)[number];

export const RELATION_KINDS = ["one-to-one", "one-to-many", "many-to-many"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const RELATION_KIND_LABELS: Record<RelationKind, string> = {
  "one-to-one": "1:1",
  "one-to-many": "1:N",
  "many-to-many": "M:N",
};

export interface DatabaseFieldDto {
  name: string;
  type: string;
  nullable: boolean;
  isPrimary: boolean;
  isUnique: boolean;
  defaultValue: string | null;
  description: string;
}

export interface DatabaseTableDto {
  name: string;
  description: string;
  indexes: string[];
  fields: DatabaseFieldDto[];
}

export interface DatabaseRelationDto {
  fromTable: string;
  fromField: string;
  toTable: string;
  toField: string;
  kind: RelationKind;
}

export interface DatabaseSchemaDto {
  engine: string;
  tables: DatabaseTableDto[];
  relations: DatabaseRelationDto[];
}

export const architectureDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.enum(ARCHITECTURE_STATUSES),
  summary: z.string(),
  frontendArch: z.string(),
  backendArch: z.string(),
  rationale: z.string(),
  directoryTree: z.string(),
  techStack: z.array(
    z.object({ layer: z.enum(TECH_LAYERS), name: z.string(), reason: z.string() }),
  ),
  modules: z.array(
    z.object({ name: z.string(), description: z.string(), layer: z.enum(MODULE_LAYERS) }),
  ),
  apis: z.array(
    z.object({
      method: z.enum(API_METHODS),
      path: z.string(),
      module: z.string(),
      summary: z.string(),
      requiresAuth: z.boolean(),
    }),
  ),
  permissions: z.array(
    z.object({ role: z.string(), resource: z.string(), action: z.string(), note: z.string() }),
  ),
  database: z
    .object({
      engine: z.string(),
      tables: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          indexes: z.array(z.string()),
          fields: z.array(
            z.object({
              name: z.string(),
              type: z.string(),
              nullable: z.boolean(),
              isPrimary: z.boolean(),
              isUnique: z.boolean(),
              defaultValue: z.string().nullable(),
              description: z.string(),
            }),
          ),
        }),
      ),
      relations: z.array(
        z.object({
          fromTable: z.string(),
          fromField: z.string(),
          toTable: z.string(),
          toField: z.string(),
          kind: z.enum(RELATION_KINDS),
        }),
      ),
    })
    .nullable(),
  updatedAt: z.string(),
});

export type ArchitectureDto = z.infer<typeof architectureDtoSchema>;
