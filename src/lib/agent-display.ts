import type { AgentStepDto } from "./agent";

/** Presentation only: keep the task's original steps intact for progress/recovery. */
export function isCheckpointStep(step: AgentStepDto): boolean {
  return (
    step.detail.trimStart().startsWith("FULL_PROJECT_CHECKPOINT") ||
    step.title === "完整项目生成检查点"
  );
}

export function latestVisibleAgentSteps(steps: readonly AgentStepDto[]): AgentStepDto[] {
  return steps.filter((step) => !isCheckpointStep(step)).sort((a, b) => b.index - a.index);
}

/** Match only the exact internal recovery marker, never arbitrary failure messages. */
export function isSafeBatchSplitStep(step: AgentStepDto): boolean {
  return (
    step.kind === "code" && step.status === "failed" && step.detail.trim() === "SAFE_BATCH_SPLIT"
  );
}

export function repairModuleTitle(id: string): string | null {
  const match = /^repair-([1-9]\d*)$/.exec(id);
  return match ? `第 ${match[1]} 轮验收修复` : null;
}

export function verificationNeedsAttention(step: AgentStepDto): boolean {
  if (step.status === "failed") return true;
  if (step.kind !== "check" || !step.detail.startsWith("ACCEPTANCE_REPORT\n")) return false;
  try {
    const report = JSON.parse(step.detail.slice("ACCEPTANCE_REPORT\n".length));
    return report.status === "failed" || report.status === "blocked";
  } catch {
    return true;
  }
}

export type AgentModuleDisplay = { id: string; title: string };
export type AgentStepGroup = {
  id: string;
  title: string;
  steps: AgentStepDto[];
  defaultOpen: boolean;
  status: "running" | "failed" | "done" | "recorded";
};

/** Group by stable module identity, including its planning step; input remains untouched. */
export function groupAgentSteps(
  steps: readonly AgentStepDto[],
  modules: readonly AgentModuleDisplay[] = [],
  completedIds: readonly string[] = [],
): AgentStepGroup[] {
  const groups = new Map<string, AgentStepGroup>();
  const named = new Map(modules.map((module) => [module.title, module]));
  let current: AgentModuleDisplay | null = null;
  let verificationId: string | null = null;
  for (const step of [...latestVisibleAgentSteps(steps)].reverse()) {
    const batch = /^FULL_PROJECT_BATCH:[^:]+:([^:]+):[^:]+$/.exec(step.title);
    if (step.title.startsWith("模块计划：")) {
      const title = step.title.slice("模块计划：".length).trim();
      current = named.get(title) ?? { id: `title:${title}`, title };
    } else if (batch) {
      current = modules.find((module) => module.id === batch[1]) ?? {
        id: batch[1],
        title: repairModuleTitle(batch[1]) ?? "模块开发",
      };
    }
    const stepModule = batch || step.title.startsWith("模块计划：") ? current : null;
    const verification =
      (step.kind === "install" && step.title.startsWith("安装依赖：")) ||
      (step.kind === "check" && step.title === "完整项目工程验收：构建、测试与占位检查");
    if (!verification) verificationId = null;
    else verificationId ??= `verification:${step.id}`;
    const id = verification
      ? verificationId!
      : stepModule
        ? `module:${stepModule.id}`
        : `step:${step.id}`;
    const group = groups.get(id) ?? {
      id,
      title: verification ? "依赖检查与工程验收" : (stepModule?.title ?? step.title),
      steps: [],
      defaultOpen: false,
      status: "recorded" as const,
    };
    group.steps.unshift(step);
    groups.set(id, group);
  }
  const result = [...groups.values()].sort((a, b) => b.steps[0].index - a.steps[0].index);
  for (const group of result) {
    const completed = group.id.startsWith("module:") && completedIds.includes(group.id.slice(7));
    group.status = group.steps.some((step) => step.status === "running")
      ? "running"
      : group.id.startsWith("verification:") && group.steps.some(verificationNeedsAttention)
        ? "failed"
        : completed ||
            group.steps.every((step) => step.status === "done" || step.status === "skipped")
          ? "done"
          : group.steps[0].status === "failed" && !isSafeBatchSplitStep(group.steps[0])
            ? "failed"
            : "recorded";
    group.defaultOpen =
      group.status === "running" ||
      ((group === result[0] || group.id.startsWith("verification:")) && group.status === "failed");
  }
  return result;
}

export type AgentPlanItem = { title: string; description: string };
export type AgentStepDetailDisplay =
  | { kind: "hidden" }
  | { kind: "text"; text: string }
  | { kind: "plan"; summary: string; countLabel: string; items: AgentPlanItem[] };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Allowlist human-facing planning fields; never stringify arbitrary debug metadata. */
export function agentStepDetailDisplay(step: AgentStepDto): AgentStepDetailDisplay {
  const detail = step.detail.trim();
  if (!detail || isCheckpointStep(step) || detail.startsWith("ACCEPTANCE_REPORT\n")) {
    return { kind: "hidden" };
  }
  if (isSafeBatchSplitStep(step))
    return {
      kind: "text",
      text: "已自动拆分为更小批次，继续生成。本次未写入文件，原计划中的文件仍会继续处理。",
    };
  // Failures remain readable and preserve their original context, rendered as text by React.
  if (step.kind !== "plan" || step.status === "failed") {
    return { kind: "text", text: step.detail };
  }
  const candidate = detail.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1").trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
    return { kind: "text", text: step.detail };
  }
  let value: Record<string, unknown> | null = null;
  try {
    value = record(JSON.parse(candidate));
  } catch {
    // A partial/invalid plan is not useful as a wall of JSON in the timeline.
  }
  const files = Array.isArray(value?.steps) ? value.steps : null;
  const modules = Array.isArray(value?.modules) ? value.modules : null;
  const items: AgentPlanItem[] = [];
  const actions: Record<string, string> = { create: "新建", modify: "修改", delete: "删除" };
  for (const raw of files ?? modules ?? []) {
    const item = record(raw);
    if (!item) continue;
    if (files) {
      const path = text(item.path);
      if (!path) continue;
      const action = typeof item.action === "string" ? actions[item.action] : undefined;
      items.push({ title: `${action ?? "处理"} ${path}`, description: text(item.reason) });
    } else {
      const title = text(item.title);
      if (!title) continue;
      items.push({ title, description: text(item.objective) });
    }
  }
  return {
    kind: "plan",
    summary:
      text(value?.summary) || text(value?.title) || "已记录开发计划，文件结果可在代码变更中查看。",
    countLabel: items.length
      ? `计划${files ? "处理" : "实现"} ${items.length} 个${files ? "文件" : "模块"}`
      : "计划内容已记录",
    items,
  };
}
