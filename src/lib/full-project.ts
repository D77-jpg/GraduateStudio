import { z } from "zod";
import { planOutputSchema } from "./develop";
import type { AcceptanceReport } from "./acceptance";

export const FULL_PROJECT_CHECKPOINT_PREFIX = "FULL_PROJECT_CHECKPOINT\n";
/** Historical defaults retained for stored tasks/UI compatibility, not execution limits. */
export const FULL_PROJECT_LIMITS = {
  modules: 12,
  steps: 240,
  modelCalls: 100,
  wallMs: 90 * 60_000,
  repairs: 2,
} as const;
export const MODULE_KINDS = [
  "foundation",
  "business",
  "api",
  "frontend",
  "tests",
  "config",
  "docs",
] as const;
export const fullProjectModuleSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  kind: z.enum(MODULE_KINDS),
  featureIds: z.array(z.string()),
  dependsOn: z.array(z.string()),
  objective: z.string().min(1).max(2000),
  acceptanceCriteria: z.array(z.string().min(1).max(500)).min(1),
});
export const fullProjectPlanSchema = z.object({
  title: z.string().min(1).max(120),
  modules: z.array(fullProjectModuleSchema).min(7),
});
export type FullProjectPlan = z.infer<typeof fullProjectPlanSchema>;
export type FullProjectModule = z.infer<typeof fullProjectModuleSchema>;

/** Reject missing/fictional coverage and topologically order before any file is generated. */
export function orderFullProjectPlan(raw: FullProjectPlan, featureIds: string[]): FullProjectPlan {
  const plan = fullProjectPlanSchema.parse(raw);
  if (!featureIds.length) throw new Error("完整生成需要已有非空需求功能，不能推断完整范围。");
  const ids = new Set(plan.modules.map((module) => module.id));
  if (ids.size !== plan.modules.length) throw new Error("模块 ID 重复");
  const covered = new Set<string>();
  for (const workModule of plan.modules) {
    for (const id of workModule.featureIds) {
      if (!featureIds.includes(id)) throw new Error(`计划引用未知需求功能 ${id}`);
      covered.add(id);
    }
    if (workModule.dependsOn.some((id) => !ids.has(id) || id === workModule.id))
      throw new Error("模块依赖无效");
  }
  if (featureIds.some((id) => !covered.has(id))) throw new Error("计划遗漏需求功能，拒绝缩减范围");
  if (MODULE_KINDS.some((kind) => !plan.modules.some((module) => module.kind === kind)))
    throw new Error("计划缺少基础/API/前端/业务/测试/配置/文档模块");
  const ordered: FullProjectModule[] = [];
  const remaining = [...plan.modules];
  while (remaining.length) {
    const rank: Record<string, number> = {
      foundation: 0,
      api: 1,
      business: 2,
      frontend: 3,
      tests: 4,
      config: 5,
      docs: 6,
    };
    const ready = remaining
      .filter((item) => item.dependsOn.every((id) => ordered.some((done) => done.id === id)))
      .sort((a, b) => rank[a.kind] - rank[b.kind]);
    const index = ready.length ? remaining.findIndex((item) => item.id === ready[0].id) : -1;
    if (index < 0) throw new Error("模块依赖存在循环");
    ordered.push(...remaining.splice(index, 1));
  }
  return { ...plan, modules: ordered };
}

export const fullProjectCheckpointSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string(),
    projectId: z.string(),
    requirementId: z.string(),
    requirementUpdatedAt: z.string(),
    scopeFingerprint: z.string().optional(),
    featureIds: z.array(z.string()),
    message: z.string(),
    phase: z.enum([
      "planning",
      "modules",
      "acceptance",
      "repair",
      "completed",
      "blocked",
      "cancelled",
    ]),
    plan: fullProjectPlanSchema.nullable(),
    completedModuleIds: z.array(z.string()),
    currentModule: fullProjectModuleSchema.nullable(),
    currentPlan: planOutputSchema.nullable(),
    batchCursor: z.number().int().nonnegative(),
    generationBatches: z.array(z.array(z.number().int().nonnegative()).min(1).max(6)).optional(),
    generationBatchKeys: z.array(z.string().min(1)).optional(),
    batchRecovery: z.object({ moduleId: z.string(), attempts: z.array(z.string()) }).optional(),
    lastRequest: z
      .object({
        type: z.enum(["started", "progress", "completed", "failed"]),
        provider: z.string().max(80),
        model: z.string().max(160),
        requestedBudget: z.number().int().positive().optional(),
        attempt: z.number().int().positive(),
        durationMs: z.number().nonnegative(),
        finishReason: z.string().max(80).optional(),
        textChars: z.number().int().nonnegative(),
        reasoningChars: z.number().int().nonnegative(),
        firstResponseMs: z.number().nonnegative().optional(),
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        reasoningTokens: z.number().int().nonnegative().optional(),
        errorKind: z.enum(["timeout", "cancelled", "network", "invalid-json"]).optional(),
        updatedAt: z.string(),
      })
      .optional(),
    executionStats: z
      .object({
        modelMs: z.number().nonnegative(),
        modelCalls: z.number().int().nonnegative(),
        stepMs: z.number().nonnegative(),
        steps: z.number().int().nonnegative(),
        lastModelMs: z.number().nonnegative().optional(),
        lastStepMs: z.number().nonnegative().optional(),
      })
      .optional(),
    maxWallMs: z.number().int().positive().optional(),
    maxModelCalls: z.number().int().positive().optional(),
    budgetExtensions: z.number().int().nonnegative().optional(),
    pendingChangeSetId: z.string().nullable(),
    appliedChangeSetIds: z.array(z.string()),
    changedFiles: z.array(
      z.object({ path: z.string(), action: z.enum(["create", "modify", "delete"]) }),
    ),
    nextStepIndex: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    actualRequests: z.number().int().nonnegative().optional(),
    repairAttempts: z.number().int().nonnegative(),
    repairFailureFingerprint: z.string().optional(),
    repairBaselineReport: z.string().optional(),
    repairEvidenceReport: z.string().optional(),
    repairFocusCheckId: z.string().optional(),
    investigation: z
      .object({
        checkId: z.string(),
        disposition: z.enum(["repair", "environment", "insufficient"]),
        summary: z.string().max(6000),
        paths: z.array(z.string()).max(30),
      })
      .optional(),
    dependencyFingerprints: z.record(z.string(), z.string()).optional(),
    maxSteps: z.number().int().positive(),
    elapsedMs: z.number().nonnegative(),
    activeSince: z.number().nullable(),
    updatedAt: z.string(),
    error: z.string().nullable(),
    acceptanceReport: z.string().nullable(),
  })
  .superRefine((checkpoint, ctx) => {
    if (
      checkpoint.generationBatchKeys &&
      (!checkpoint.generationBatches ||
        checkpoint.generationBatchKeys.length !== checkpoint.generationBatches.length ||
        new Set(checkpoint.generationBatchKeys).size !== checkpoint.generationBatchKeys.length)
    )
      ctx.addIssue({ code: "custom", message: "批次身份与边界不一致" });
    if (checkpoint.generationBatches && checkpoint.currentPlan) {
      const flattened = checkpoint.generationBatches.flat();
      if (
        flattened.length !== checkpoint.currentPlan.steps.length ||
        flattened.some((value, index) => value !== index) ||
        checkpoint.batchCursor > checkpoint.generationBatches.length
      )
        ctx.addIssue({ code: "custom", message: "批次边界与文件计划不一致" });
    } else if (checkpoint.generationBatches?.length)
      ctx.addIssue({ code: "custom", message: "批次边界缺少文件计划" });
  });
export type FullProjectCheckpoint = z.infer<typeof fullProjectCheckpointSchema>;
export function encodeFullProjectCheckpoint(checkpoint: FullProjectCheckpoint): string {
  return (
    FULL_PROJECT_CHECKPOINT_PREFIX + JSON.stringify(fullProjectCheckpointSchema.parse(checkpoint))
  );
}
export function parseFullProjectCheckpoint(detail: string): FullProjectCheckpoint | null {
  if (!detail.startsWith(FULL_PROJECT_CHECKPOINT_PREFIX)) return null;
  try {
    return fullProjectCheckpointSchema.parse(
      JSON.parse(detail.slice(FULL_PROJECT_CHECKPOINT_PREFIX.length)),
    );
  } catch {
    return null;
  }
}
export function consumedWallMs(checkpoint: FullProjectCheckpoint, now = Date.now()): number {
  return (
    checkpoint.elapsedMs +
    (checkpoint.activeSince === null ? 0 : Math.max(0, now - checkpoint.activeSince))
  );
}
export function assertFullProjectBudget(
  checkpoint: FullProjectCheckpoint,
  modelCalls = 0,
  steps = 0,
  now = Date.now(),
): void {
  // Compatibility only: saved budgets and accumulated usage are informational.
  void checkpoint;
  void modelCalls;
  void steps;
  void now;
}
/** Compare concrete failures, not volatile report timing, ordering, or terminal formatting. */
export function fullProjectAcceptanceFailureFingerprint(
  report: Pick<AcceptanceReport, "status" | "checks">,
): string {
  const normalize = (output: string) =>
    output
      .replace(/\u001b\[[0-9;]*m/g, "")
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
      .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|seconds|secs|s)\b/gi, "<duration>")
      .replace(/\s+/g, " ")
      .trim();
  return JSON.stringify(
    report.checks
      .filter((check) => check.status === "failed" || check.status === "blocked")
      .map((check) => ({
        id: check.id,
        status: check.status,
        command: check.command,
        output: normalize(check.output),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

/** Only known code/configuration blockers are repairable; never spend AI on missing tools or inspection failures. */
export function canRepairFullProjectAcceptance(
  report: Pick<AcceptanceReport, "status" | "checks">,
): boolean {
  const issues = report.checks.filter(
    (check) => check.status === "failed" || check.status === "blocked",
  );
  if (!issues.length) return false;
  const repairableBlocked: Record<string, readonly string[]> = {
    "frontend-build": [
      "未找到支持的 client/package.json 或根目录 package.json。",
      "构建脚本缺失或无法识别；仅支持标准 Vite/Next/React/Vue 构建，不执行未知或空操作脚本。",
    ],
    "frontend-test": [
      "未找到支持的前端测试。",
      "测试脚本无法识别；仅支持直接运行 Vitest，未执行未知脚本。",
      "未声明 test 测试脚本，无法证明测试通过。",
    ],
    "backend-tests": ["server/src/test 下未找到测试源码；仅 Maven 成功不能证明测试通过。"],
    "backend-verify": [
      "未找到支持的 server/pom.xml 后端项目。",
      "未找到支持的 server/pom.xml、backend/package.json 或 server/package.json 后端项目。",
    ],
    "backend-test": [
      "后端未找到测试源码；不能仅凭 test 脚本或退出码判定通过。",
      "未声明受支持的真实测试脚本；仅支持 node --test 或直接 Vitest，不执行未知或空操作脚本。",
    ],
    "backend-build": ["后端 build 脚本无法识别；仅支持声明 TypeScript 依赖的直接 tsc 构建。"],
  };
  return issues.every(
    (check) =>
      check.status === "failed" ||
      check.id === "implementation-placeholders" ||
      repairableBlocked[check.id]?.includes(check.output),
  );
}

export function fullProjectBatchTitle(
  taskId: string,
  moduleId: string,
  batchCursor: number,
): string {
  return `FULL_PROJECT_BATCH:${taskId}:${moduleId}:${batchCursor}`;
}
