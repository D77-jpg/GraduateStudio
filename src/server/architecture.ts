import { db } from "@/server/db";
import type { Architecture, DatabaseField, DatabaseTable } from "@prisma/client";
import {
  architectureDtoSchema,
  type ArchitectureDto,
  type ArchitectureStatus,
} from "@/lib/architecture";
import type {
  ArchitectureOverviewOutput,
  DatabaseOnlyOutput,
} from "@/server/agents/architect-agent";

/**
 * 架构服务:
 * - AI 全量生成 → 草稿(draft);用户确认(confirmed)后不被任何自动流程覆盖
 * - 已确认状态下重新分析被拒绝,需先显式「撤销确认」
 * - 数据库设计支持局部重新生成(仅草稿状态)
 */

export class ArchitectureAccessError extends Error {}
export class ArchitectureStateError extends Error {}

function safeJsonArray<T>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function toArchitectureDto(
  row: Architecture & {
    techStacks: Array<{ layer: string; name: string; reason: string; order: number }>;
    modules: Array<{ name: string; description: string; layer: string; order: number }>;
    apiDefinitions: Array<{
      method: string;
      path: string;
      module: string;
      summary: string;
      requiresAuth: boolean;
      order: number;
    }>;
    permissionRules: Array<{
      role: string;
      resource: string;
      action: string;
      note: string;
      order: number;
    }>;
    database:
      (DatabaseSchemaRow & { tables: DatabaseTableWithFields[]; relations: RelationRow[] }) | null;
  },
): ArchitectureDto {
  const byOrder = <T extends { order: number }>(items: T[]) =>
    [...items].sort((a, b) => a.order - b.order);

  return architectureDtoSchema.parse({
    id: row.id,
    projectId: row.projectId,
    status: row.status as ArchitectureStatus,
    summary: row.summary,
    frontendArch: row.frontendArch,
    backendArch: row.backendArch,
    rationale: row.rationale,
    directoryTree: row.directoryTree,
    techStack: byOrder(row.techStacks).map((t) => ({
      layer: t.layer as never,
      name: t.name,
      reason: t.reason,
    })),
    modules: byOrder(row.modules).map((m) => ({
      name: m.name,
      description: m.description,
      layer: m.layer as never,
    })),
    apis: byOrder(row.apiDefinitions).map((a) => ({
      method: a.method as never,
      path: a.path,
      module: a.module,
      summary: a.summary,
      requiresAuth: a.requiresAuth,
    })),
    permissions: byOrder(row.permissionRules).map((p) => ({
      role: p.role,
      resource: p.resource,
      action: p.action,
      note: p.note,
    })),
    database: row.database
      ? {
          engine: row.database.engine,
          tables: byOrder(row.database.tables).map((table) => ({
            name: table.name,
            description: table.description,
            indexes: safeJsonArray<string>(table.indexesJson),
            fields: byOrder(table.fields).map((field) => ({
              name: field.name,
              type: field.type,
              nullable: field.nullable,
              isPrimary: field.isPrimary,
              isUnique: field.isUnique,
              defaultValue: field.defaultValue,
              description: field.description,
            })),
          })),
          relations: row.database.relations.map((relation) => ({
            fromTable: relation.fromTable,
            fromField: relation.fromField,
            toTable: relation.toTable,
            toField: relation.toField,
            kind: relation.kind as never,
          })),
        }
      : null,
    updatedAt: row.updatedAt.toISOString(),
  });
}

type DatabaseSchemaRow = { id: string; engine: string };
type DatabaseTableWithFields = DatabaseTable & { fields: DatabaseField[] };
type RelationRow = {
  fromTable: string;
  fromField: string;
  toTable: string;
  toField: string;
  kind: string;
};

async function loadOwnedArchitectureFull(projectId: string, userId: string) {
  const row = await db.architecture.findFirst({
    where: { projectId, project: { userId } },
    include: {
      techStacks: true,
      modules: true,
      apiDefinitions: true,
      permissionRules: true,
      database: { include: { tables: { include: { fields: true } }, relations: true } },
    },
  });
  return row;
}

export async function getArchitecture(
  projectId: string,
  userId: string,
): Promise<ArchitectureDto | null> {
  const row = await loadOwnedArchitectureFull(projectId, userId);
  return row ? toArchitectureDto(row) : null;
}

async function assertProjectOwner(projectId: string, userId: string): Promise<void> {
  const project = await db.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!project) throw new ArchitectureAccessError("项目不存在或无权访问");
}

async function writeArchitecture(
  projectId: string,
  userId: string,
  output: ArchitectureOverviewOutput,
  database: DatabaseOnlyOutput,
): Promise<ArchitectureDto> {
  await db.$transaction(async (tx) => {
    const existing = await tx.architecture.findUnique({ where: { projectId } });
    if (existing) {
      await tx.technologyStack.deleteMany({ where: { architectureId: existing.id } });
      await tx.architectureModule.deleteMany({ where: { architectureId: existing.id } });
      await tx.apiDefinition.deleteMany({ where: { architectureId: existing.id } });
      await tx.permissionRule.deleteMany({ where: { architectureId: existing.id } });
      await tx.databaseRelation.deleteMany({
        where: { schemaRef: { architectureId: existing.id } },
      });
      await tx.databaseField.deleteMany({
        where: { table: { schemaRef: { architectureId: existing.id } } },
      });
      await tx.databaseTable.deleteMany({ where: { schemaRef: { architectureId: existing.id } } });
      await tx.databaseSchema.deleteMany({ where: { architectureId: existing.id } });
      await tx.architecture.delete({ where: { id: existing.id } });
    }

    const architecture = await tx.architecture.create({
      data: {
        projectId,
        status: "draft",
        summary: output.summary,
        frontendArch: output.frontendArch,
        backendArch: output.backendArch,
        rationale: output.rationale,
        directoryTree: output.directoryTree,
      },
    });

    await tx.technologyStack.createMany({
      data: output.techStack.map((item, index) => ({
        architectureId: architecture.id,
        layer: item.layer,
        name: item.name,
        reason: item.reason,
        order: index,
      })),
    });
    await tx.architectureModule.createMany({
      data: output.modules.map((item, index) => ({
        architectureId: architecture.id,
        name: item.name,
        description: item.description,
        layer: item.layer,
        order: index,
      })),
    });
    await tx.apiDefinition.createMany({
      data: output.apis.map((item, index) => ({
        architectureId: architecture.id,
        method: item.method,
        path: item.path,
        module: item.module,
        summary: item.summary,
        requiresAuth: item.requiresAuth,
        order: index,
      })),
    });
    await tx.permissionRule.createMany({
      data: output.permissions.map((item, index) => ({
        architectureId: architecture.id,
        role: item.role,
        resource: item.resource,
        action: item.action,
        note: item.note,
        order: index,
      })),
    });

    const schema = await tx.databaseSchema.create({
      data: { architectureId: architecture.id, engine: database.engine },
    });
    for (const [tableIndex, table] of database.tables.entries()) {
      const created = await tx.databaseTable.create({
        data: {
          schemaId: schema.id,
          name: table.name,
          description: table.description,
          indexesJson: JSON.stringify(table.indexes),
          order: tableIndex,
        },
      });
      await tx.databaseField.createMany({
        data: table.fields.map((field, fieldIndex) => ({
          tableId: created.id,
          name: field.name,
          type: field.type,
          nullable: field.nullable,
          isPrimary: field.isPrimary,
          isUnique: field.isUnique,
          defaultValue: field.defaultValue || null,
          description: field.description,
          order: fieldIndex,
        })),
      });
    }
    await tx.databaseRelation.createMany({
      data: database.relations.map((relation) => ({
        schemaId: schema.id,
        fromTable: relation.fromTable,
        fromField: relation.fromField,
        toTable: relation.toTable,
        toField: relation.toField,
        kind: relation.kind,
      })),
    });
  });

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { progress: true },
  });
  await db.project.update({
    where: { id: projectId },
    data: { stage: "architecture", progress: Math.max(project?.progress ?? 0, 35) },
  });

  const dto = await getArchitecture(projectId, userId);
  if (!dto) throw new Error("架构落库后读取失败");
  return dto;
}

/** AI 全量生成(或覆盖草稿)。已确认的架构不可覆盖。 */
export async function generateArchitectureDraft(
  projectId: string,
  userId: string,
  output: ArchitectureOverviewOutput,
  database: DatabaseOnlyOutput,
): Promise<ArchitectureDto> {
  await assertProjectOwner(projectId, userId);
  const existing = await db.architecture.findUnique({
    where: { projectId },
    select: { status: true },
  });
  if (existing?.status === "confirmed") {
    throw new ArchitectureStateError(
      "当前架构已确认。请先「撤销确认」再重新生成,已确认内容不会被自动覆盖。",
    );
  }
  return writeArchitecture(projectId, userId, output, database);
}

/** 确认草稿 → confirmed,推进阶段。 */
export async function confirmArchitecture(
  projectId: string,
  userId: string,
): Promise<ArchitectureDto> {
  await assertProjectOwner(projectId, userId);
  const existing = await db.architecture.findUnique({
    where: { projectId },
    select: { id: true, status: true },
  });
  if (!existing) throw new ArchitectureStateError("尚未生成架构");
  if (existing.status === "confirmed") throw new ArchitectureStateError("架构已经是确认状态");

  await db.architecture.update({ where: { id: existing.id }, data: { status: "confirmed" } });
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { progress: true },
  });
  await db.project.update({
    where: { id: projectId },
    data: { stage: "architecture", progress: Math.max(project?.progress ?? 0, 40) },
  });

  const dto = await getArchitecture(projectId, userId);
  if (!dto) throw new Error("架构读取失败");
  return dto;
}

/** 撤销确认:confirmed → draft(用户显式操作,之后可重新生成)。 */
export async function unconfirmArchitecture(
  projectId: string,
  userId: string,
): Promise<ArchitectureDto> {
  await assertProjectOwner(projectId, userId);
  const existing = await db.architecture.findUnique({
    where: { projectId },
    select: { id: true, status: true },
  });
  if (!existing) throw new ArchitectureStateError("尚未生成架构");
  if (existing.status !== "confirmed") throw new ArchitectureStateError("当前不是确认状态");

  await db.architecture.update({ where: { id: existing.id }, data: { status: "draft" } });
  const dto = await getArchitecture(projectId, userId);
  if (!dto) throw new Error("架构读取失败");
  return dto;
}

/** 拒绝并丢弃草稿(回到未生成状态)。 */
export async function discardArchitecture(projectId: string, userId: string): Promise<void> {
  await assertProjectOwner(projectId, userId);
  const existing = await db.architecture.findUnique({
    where: { projectId },
    select: { id: true, status: true },
  });
  if (!existing) throw new ArchitectureStateError("尚未生成架构");
  if (existing.status === "confirmed") {
    throw new ArchitectureStateError("已确认的架构不能丢弃,请先撤销确认");
  }

  await db.$transaction(async (tx) => {
    await tx.databaseRelation.deleteMany({ where: { schemaRef: { architectureId: existing.id } } });
    await tx.databaseField.deleteMany({
      where: { table: { schemaRef: { architectureId: existing.id } } },
    });
    await tx.databaseTable.deleteMany({ where: { schemaRef: { architectureId: existing.id } } });
    await tx.databaseSchema.deleteMany({ where: { architectureId: existing.id } });
    await tx.technologyStack.deleteMany({ where: { architectureId: existing.id } });
    await tx.architectureModule.deleteMany({ where: { architectureId: existing.id } });
    await tx.apiDefinition.deleteMany({ where: { architectureId: existing.id } });
    await tx.permissionRule.deleteMany({ where: { architectureId: existing.id } });
    await tx.architecture.delete({ where: { id: existing.id } });
  });
}

/** 局部重新生成:仅替换数据库设计(仅草稿状态可执行)。 */
export async function regenerateDatabaseSection(
  projectId: string,
  userId: string,
  output: DatabaseOnlyOutput,
): Promise<ArchitectureDto> {
  await assertProjectOwner(projectId, userId);
  const existing = await db.architecture.findUnique({
    where: { projectId },
    select: { id: true, status: true },
  });
  if (!existing) throw new ArchitectureStateError("尚未生成架构");
  if (existing.status === "confirmed") {
    throw new ArchitectureStateError("当前架构已确认,局部重新生成前请先撤销确认。");
  }

  await db.$transaction(async (tx) => {
    await tx.databaseRelation.deleteMany({ where: { schemaRef: { architectureId: existing.id } } });
    await tx.databaseField.deleteMany({
      where: { table: { schemaRef: { architectureId: existing.id } } },
    });
    await tx.databaseTable.deleteMany({ where: { schemaRef: { architectureId: existing.id } } });
    await tx.databaseSchema.deleteMany({ where: { architectureId: existing.id } });

    const schema = await tx.databaseSchema.create({
      data: { architectureId: existing.id, engine: output.engine },
    });
    for (const [tableIndex, table] of output.tables.entries()) {
      const created = await tx.databaseTable.create({
        data: {
          schemaId: schema.id,
          name: table.name,
          description: table.description,
          indexesJson: JSON.stringify(table.indexes),
          order: tableIndex,
        },
      });
      await tx.databaseField.createMany({
        data: table.fields.map((field, fieldIndex) => ({
          tableId: created.id,
          name: field.name,
          type: field.type,
          nullable: field.nullable,
          isPrimary: field.isPrimary,
          isUnique: field.isUnique,
          defaultValue: field.defaultValue || null,
          description: field.description,
          order: fieldIndex,
        })),
      });
    }
    await tx.databaseRelation.createMany({
      data: output.relations.map((relation) => ({
        schemaId: schema.id,
        fromTable: relation.fromTable,
        fromField: relation.fromField,
        toTable: relation.toTable,
        toField: relation.toField,
        kind: relation.kind,
      })),
    });
  });

  const dto = await getArchitecture(projectId, userId);
  if (!dto) throw new Error("架构读取失败");
  return dto;
}
