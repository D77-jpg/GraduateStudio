import { z } from "zod";

/** Phase 5:自主开发任务领域模型(前后端共享)。 */

export const AGENT_TASK_STATUSES = [
  "queued",
  "analyzing",
  "planning",
  "coding",
  "checking",
  "fixing",
  "completed",
  "failed",
  "cancelled",
  "paused",
] as const;

export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

export const AGENT_TASK_STATUS_LABELS: Record<AgentTaskStatus, string> = {
  queued: "排队中",
  analyzing: "分析中",
  planning: "规划中",
  coding: "编码中",
  checking: "自检中",
  fixing: "修复中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  paused: "已暂停",
};

export const AGENT_STEP_KINDS = [
  "analyze",
  "plan",
  "code",
  "install",
  "check",
  "fix",
  "note",
  "diagnostic",
] as const;

export type AgentStepKind = (typeof AGENT_STEP_KINDS)[number];

export const AGENT_STEP_KIND_LABELS: Record<AgentStepKind, string> = {
  analyze: "分析",
  plan: "规划",
  code: "编码",
  install: "依赖",
  check: "自检",
  fix: "修复",
  note: "备注",
  diagnostic: "诊断",
};

export const ACTIVE_AGENT_STATUSES: AgentTaskStatus[] = [
  "queued",
  "analyzing",
  "planning",
  "coding",
  "checking",
  "fixing",
];

export function isActiveStatus(status: string): boolean {
  return ACTIVE_AGENT_STATUSES.includes(status as AgentTaskStatus);
}

export const agentStepDtoSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  kind: z.enum(AGENT_STEP_KINDS),
  title: z.string(),
  status: z.enum(["running", "done", "failed", "skipped"]),
  detail: z.string(),
  changeSetId: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

export type AgentStepDto = z.infer<typeof agentStepDtoSchema>;

export const agentPlanModuleDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["done", "current", "pending"]),
});

/** Codex 引擎的计划进度：用户在任务卡上直接看到 8 个模块各自处于什么状态。 */
export const agentPlanProgressDtoSchema = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  modules: z.array(agentPlanModuleDtoSchema),
});

export const agentExecutionDtoSchema = z.object({
  engine: z.literal("codex"),
  mode: z.enum(["local", "full"]),
  phase: z.enum(["running", "paused", "interrupted", "awaiting_acceptance", "applied_unverified", "completed", "cancelled", "failed"]),
  attempt: z.number().int().nonnegative(),
  resumable: z.boolean(),
  pendingChangeSetId: z.string().nullable(),
  plan: agentPlanProgressDtoSchema.nullable().optional(),
});

export const agentTaskDtoSchema = z.object({
  execution: agentExecutionDtoSchema.nullable().optional(),
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  message: z.string(),
  status: z.enum(AGENT_TASK_STATUSES),
  maxSteps: z.number().int(),
  fixAttempts: z.number().int(),
  error: z.string().nullable(),
  gitCommitHash: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  steps: z.array(agentStepDtoSchema),
});

export type AgentTaskDto = z.infer<typeof agentTaskDtoSchema>;

/** Presentation projection: stale attempts are interrupted, never treated as successful. */
export function effectiveAgentSteps(task: AgentTaskDto): AgentStepDto[] {
  const latestIndex = Math.max(
    -1,
    ...task.steps
      .filter((s) => !s.detail.startsWith("FULL_PROJECT_CHECKPOINT"))
      .map((s) => s.index),
  );
  return task.steps.map((step) =>
    step.status === "running" && (!isActiveStatus(task.status) || step.index < latestIndex)
      ? {
          ...step,
          status: "failed" as const,
          detail: step.detail || "该次执行已中断；历史记录保留，不代表仍在运行。",
        }
      : step,
  );
}
