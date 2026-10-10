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

export const agentTaskDtoSchema = z.object({
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
