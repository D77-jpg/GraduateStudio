"use client";

import { useEffect, useState } from "react";
import type { AgentTaskDto } from "@/lib/agent";
import { AGENT_TASK_STATUS_LABELS, isActiveStatus } from "@/lib/agent";
import { repairModuleTitle } from "@/lib/agent-display";

export const FULL_PROJECT_CHECKPOINT_MARKER = "FULL_PROJECT_CHECKPOINT\n";

const PHASE_LABELS: Record<string, string> = {
  planning: "规划模块",
  modules: "生成模块代码",
  acceptance: "构建与测试验收",
  repair: "自动修复",
  completed: "执行结束",
  blocked: "等待处理 / 已停止",
  cancelled: "已取消",
};

type ExecutionStats = {
  modelMs: number;
  modelCalls: number;
  stepMs: number;
  steps: number;
  lastModelMs: number | null;
  lastStepMs: number | null;
};

type ExecutionCounters = {
  elapsedMs: number;
  activeSince: number | null;
  nextStepIndex: number;
};

type RequestDiagnostic = {
  type: "started" | "progress" | "completed" | "failed";
  provider: string;
  model: string;
  requestedBudget?: number;
  attempt: number;
  durationMs: number;
  textChars: number;
  reasoningChars: number;
  firstResponseMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  finishReason?: string;
  errorKind?: "timeout" | "cancelled" | "network" | "invalid-json";
  updatedAt: string;
};

const REQUEST_ERROR_LABELS = {
  timeout: "请求超时",
  cancelled: "请求已取消",
  network: "网络或服务连接失败",
  "invalid-json": "返回结果不是有效 JSON",
};

type Checkpoint = {
  phase: string;
  modules: { id: string; title: string }[];
  completedModuleIds: string[];
  currentModuleId: string | null;
  modelCalls: number | null;
  repairAttempts: number | null;
  error: string | null;
  counters: ExecutionCounters | null;
  executionStats: ExecutionStats | null;
  actualRequests: number | null;
  lastRequest: RequestDiagnostic | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function readExecutionCounters(value: Record<string, unknown>): ExecutionCounters | null {
  // Retired limits and extension fields are deliberately ignored, even when corrupt.
  if (
    nonnegativeNumber(value.elapsedMs) === null ||
    !(value.activeSince === null || nonnegativeNumber(value.activeSince) !== null) ||
    !integer(value.nextStepIndex)
  )
    return null;
  return {
    elapsedMs: value.elapsedMs as number,
    activeSince: value.activeSince as number | null,
    nextStepIndex: value.nextStepIndex,
  };
}

function readExecutionStats(value: unknown): ExecutionStats | null {
  if (
    !isRecord(value) ||
    nonnegativeNumber(value.modelMs) === null ||
    !integer(value.modelCalls) ||
    nonnegativeNumber(value.stepMs) === null ||
    !integer(value.steps) ||
    (value.lastModelMs !== undefined && nonnegativeNumber(value.lastModelMs) === null) ||
    (value.lastStepMs !== undefined && nonnegativeNumber(value.lastStepMs) === null)
  )
    return null;
  return {
    modelMs: value.modelMs as number,
    modelCalls: value.modelCalls,
    stepMs: value.stepMs as number,
    steps: value.steps,
    lastModelMs: nonnegativeNumber(value.lastModelMs),
    lastStepMs: nonnegativeNumber(value.lastStepMs),
  };
}

function readRequestDiagnostic(value: unknown): RequestDiagnostic | null {
  if (
    !isRecord(value) ||
    !["started", "progress", "completed", "failed"].includes(value.type as string) ||
    typeof value.provider !== "string" ||
    value.provider.length > 80 ||
    typeof value.model !== "string" ||
    value.model.length > 160 ||
    (value.requestedBudget !== undefined && !integer(value.requestedBudget, 1)) ||
    !integer(value.attempt, 1) ||
    nonnegativeNumber(value.durationMs) === null ||
    !integer(value.textChars) ||
    !integer(value.reasoningChars) ||
    (value.firstResponseMs !== undefined && nonnegativeNumber(value.firstResponseMs) === null) ||
    [value.inputTokens, value.outputTokens, value.reasoningTokens].some(
      (count) => count !== undefined && !integer(count),
    ) ||
    (value.finishReason !== undefined &&
      (typeof value.finishReason !== "string" || value.finishReason.length > 80)) ||
    (value.errorKind !== undefined &&
      (typeof value.errorKind !== "string" ||
        !Object.hasOwn(REQUEST_ERROR_LABELS, value.errorKind))) ||
    typeof value.updatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.updatedAt) ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    return null;
  // Explicitly whitelist metadata: never carry response text or internal reasoning into the UI.
  return {
    type: value.type as RequestDiagnostic["type"],
    provider: value.provider,
    model: value.model,
    ...(value.requestedBudget !== undefined
      ? { requestedBudget: value.requestedBudget as number }
      : {}),
    attempt: value.attempt,
    durationMs: value.durationMs as number,
    textChars: value.textChars,
    reasoningChars: value.reasoningChars,
    ...(value.firstResponseMs !== undefined
      ? { firstResponseMs: value.firstResponseMs as number }
      : {}),
    ...(value.inputTokens !== undefined ? { inputTokens: value.inputTokens as number } : {}),
    ...(value.outputTokens !== undefined ? { outputTokens: value.outputTokens as number } : {}),
    ...(value.reasoningTokens !== undefined
      ? { reasoningTokens: value.reasoningTokens as number }
      : {}),
    ...(value.finishReason !== undefined ? { finishReason: value.finishReason as string } : {}),
    ...(value.errorKind !== undefined
      ? { errorKind: value.errorKind as RequestDiagnostic["errorKind"] }
      : {}),
    updatedAt: value.updatedAt,
  };
}

/** Read only the display fields; malformed or newer checkpoint data must not break task history. */
export function readFullProjectCheckpoint(task: AgentTaskDto): Checkpoint | null {
  const steps = [...task.steps].sort((a, b) => b.index - a.index);
  for (const step of steps) {
    const detail = step.detail.trimStart();
    if (!detail.startsWith(FULL_PROJECT_CHECKPOINT_MARKER)) continue;
    try {
      const value: unknown = JSON.parse(detail.slice(FULL_PROJECT_CHECKPOINT_MARKER.length));
      if (
        !isRecord(value) ||
        typeof value.phase !== "string" ||
        !Object.hasOwn(PHASE_LABELS, value.phase) ||
        (value.plan !== null && (!isRecord(value.plan) || !Array.isArray(value.plan.modules))) ||
        !Array.isArray(value.completedModuleIds) ||
        value.completedModuleIds.some((id) => typeof id !== "string") ||
        (value.currentModule !== null &&
          (!isRecord(value.currentModule) || typeof value.currentModule.id !== "string")) ||
        !integer(value.modelCalls) ||
        !integer(value.repairAttempts) ||
        (value.executionStats !== undefined && !readExecutionStats(value.executionStats)) ||
        (value.actualRequests !== undefined && !integer(value.actualRequests)) ||
        (value.lastRequest !== undefined && !readRequestDiagnostic(value.lastRequest))
      )
        return null;
      const rawModules =
        isRecord(value.plan) && Array.isArray(value.plan.modules) ? value.plan.modules : [];
      const modules: Checkpoint["modules"] = [];
      const ids = new Set<string>();
      for (const item of rawModules) {
        if (
          !isRecord(item) ||
          typeof item.id !== "string" ||
          typeof item.title !== "string" ||
          ids.has(item.id)
        )
          return null;
        ids.add(item.id);
        modules.push({ id: item.id, title: item.title });
      }
      if (
        value.completedModuleIds.some((id) => !ids.has(id) && !repairModuleTitle(id)) ||
        (isRecord(value.currentModule) &&
          !ids.has(value.currentModule.id as string) &&
          !repairModuleTitle(value.currentModule.id as string))
      )
        return null;
      return {
        phase: value.phase,
        modules,
        completedModuleIds: Array.isArray(value.completedModuleIds)
          ? value.completedModuleIds.filter((id): id is string => typeof id === "string")
          : [],
        currentModuleId:
          isRecord(value.currentModule) && typeof value.currentModule.id === "string"
            ? value.currentModule.id
            : null,
        modelCalls: nonnegativeNumber(value.modelCalls),
        repairAttempts: nonnegativeNumber(value.repairAttempts),
        error: typeof value.error === "string" ? value.error : null,
        counters: readExecutionCounters(value),
        executionStats: readExecutionStats(value.executionStats),
        actualRequests:
          value.actualRequests === undefined ? null : (value.actualRequests as number),
        lastRequest: readRequestDiagnostic(value.lastRequest),
      };
    } catch {
      // Never fall back to older state when the authoritative latest checkpoint is malformed.
      return null;
    }
  }
  return null;
}

export function isFullProjectTask(task: AgentTaskDto): boolean {
  return (
    (task as AgentTaskDto & { mode?: string }).mode === "full" ||
    task.title.startsWith("[完整生成]") ||
    task.steps.some((step) => step.detail.trimStart().startsWith(FULL_PROJECT_CHECKPOINT_MARKER))
  );
}

export function getFullProjectExecutionState(task: AgentTaskDto, now = Date.now()) {
  const checkpoint = readFullProjectCheckpoint(task);
  const counters = checkpoint?.counters;
  if (!checkpoint || !counters || checkpoint.modelCalls === null) return null;
  // Count active execution time, not time since creation; pauses do not accrue.
  const elapsedMs =
    counters.elapsedMs +
    (counters.activeSince === null ? 0 : Math.max(0, now - counters.activeSince));
  return { ...counters, elapsedMs, modelCalls: checkpoint.modelCalls };
}

export function formatFullProjectDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** Internal batch identifiers are not user-facing progress titles. */
export function formatFullProjectStepTitle(task: AgentTaskDto, title: string): string {
  const match = /^FULL_PROJECT_BATCH:([^:]+):([^:]+):([^:]+)$/.exec(title);
  if (!title.startsWith("FULL_PROJECT_BATCH:")) return title;
  if (!match) return "生成模块代码批次";
  const plannedModule = readFullProjectCheckpoint(task)?.modules.find(
    (item) => item.id === match[2],
  );
  const cursor = Number(match[3]);
  const modulePrefix = `FULL_PROJECT_BATCH:${match[1]}:${match[2]}:`;
  const executedTitles = [
    ...new Set(
      [...task.steps]
        .sort((a, b) => a.index - b.index)
        .map((step) => step.title)
        .filter((item) => typeof item === "string" && item.startsWith(modulePrefix)),
    ),
  ];
  const executedIndex = executedTitles.indexOf(title);
  const fileIndices = /^files-(\d+(?:-\d+)*)$/.exec(match[3]);
  const fileCount = fileIndices ? fileIndices[1].split("-").length : null;
  const ordinal =
    executedIndex >= 0
      ? executedIndex + 1
      : /^\d+$/.test(match[3]) && Number.isSafeInteger(cursor + 1)
        ? cursor + 1
        : null;
  const batch =
    ordinal !== null
      ? ` · 第 ${ordinal} 批${fileCount !== null ? ` · ${fileCount} 个文件` : ""}`
      : fileCount !== null
        ? ` · 生成 ${fileCount} 个文件`
        : " · 代码生成";
  const repairTitle = repairModuleTitle(match[2]);
  return repairTitle
    ? `${repairTitle}${batch}`
    : plannedModule
      ? `生成模块：${plannedModule.title}${batch}`
      : `生成模块代码${batch}`;
}

/** Progress timestamps describe the latest update, while durationMs is elapsed from request start. */
export function getFullProjectRequestState(request: RequestDiagnostic, now?: number | null) {
  const active = request.type === "started" || request.type === "progress";
  const updatedAt = Date.parse(request.updatedAt);
  const elapsedMs = request.durationMs + (active ? Math.max(0, (now ?? updatedAt) - updatedAt) : 0);
  return { active, elapsedMs };
}

export function FullProjectProgress({ task }: { task: AgentTaskDto }) {
  const [now, setNow] = useState<number | null>(null);
  const checkpoint = readFullProjectCheckpoint(task);
  const taskActive = isActiveStatus(task.status);
  const staleRequest =
    !taskActive &&
    (checkpoint?.lastRequest?.type === "started" || checkpoint?.lastRequest?.type === "progress");
  const request = staleRequest
    ? { ...checkpoint!.lastRequest!, type: "failed" as const, errorKind: "cancelled" as const }
    : checkpoint?.lastRequest;
  const requestState = request ? getFullProjectRequestState(request, now) : null;
  const requestActive = requestState?.active ?? false;
  useEffect(() => {
    if (!taskActive || (checkpoint?.counters?.activeSince == null && !requestActive)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [checkpoint?.counters?.activeSince, requestActive, taskActive]);
  if (!isFullProjectTask(task)) return null;
  const execution = getFullProjectExecutionState(
    task,
    now ?? checkpoint?.counters?.activeSince ?? 0,
  );
  const stats = checkpoint?.executionStats;
  const malformed =
    !checkpoint &&
    task.steps.some((step) => step.detail.trimStart().startsWith(FULL_PROJECT_CHECKPOINT_MARKER));
  const completed = new Set(checkpoint?.completedModuleIds ?? []);
  const completedCount =
    checkpoint?.modules.filter((module) => completed.has(module.id)).length ?? 0;

  return (
    <section
      aria-label="完整项目生成进度"
      className="mt-4 rounded-xl border border-violet-100 bg-violet-50/50 p-4 dark:border-violet-500/20 dark:bg-violet-500/5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">完整项目生成进度</h3>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          {checkpoint ? (PHASE_LABELS[checkpoint.phase] ?? "检查点阶段待识别") : "正在规划"} ·{" "}
          {AGENT_TASK_STATUS_LABELS[task.status]}
        </p>
      </div>
      {request ? (
        <div
          aria-label="当前代码生成请求"
          className="mt-3 space-y-1 rounded-lg border border-violet-100 bg-white/70 p-3 text-xs text-zinc-600 dark:border-violet-500/20 dark:bg-zinc-900/60 dark:text-zinc-400"
        >
          <p className="font-medium text-zinc-800 dark:text-zinc-200">
            {staleRequest
              ? "上次请求已中断"
              : request.type === "started"
                ? "正在生成代码 · 等待返回"
                : request.type === "progress"
                  ? request.textChars > 0
                    ? "正在接收生成内容"
                    : "服务已响应 · 等待生成内容"
                  : request.type === "completed"
                    ? "最近请求已返回"
                    : "最近请求未成功"}
          </p>
          <p className="break-all">请求模型：{request.model}</p>
          <p>
            {requestActive
              ? `${request.type === "started" ? "已等待" : "请求已进行"} ${formatFullProjectDuration(requestState?.elapsedMs ?? request.durationMs)}`
              : `请求耗时 ${formatFullProjectDuration(request.durationMs)}`}
            {request.type === "progress" && request.textChars > 0
              ? ` · 已接收 ${request.textChars} 字符`
              : ""}
            {request.type === "failed" && request.errorKind
              ? ` · ${REQUEST_ERROR_LABELS[request.errorKind]}`
              : ""}
          </p>
          {request.type === "started" ? (
            <p>请求已发起，尚未收到响应；等待时长不代表模型生成进度。</p>
          ) : null}
        </div>
      ) : null}
      {execution ? (
        <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
          已运行 {formatFullProjectDuration(execution.elapsedMs)}
        </p>
      ) : null}
      {checkpoint?.phase === "repair" && (
        <p className="mt-3 text-sm font-medium text-violet-700 dark:text-violet-300">
          当前阶段：
          {repairModuleTitle(checkpoint.currentModuleId ?? "") ??
            `第 ${checkpoint.repairAttempts ?? 0} 轮验收修复`}{" "}
          · {taskActive ? "正在处理工程检查发现的问题" : "执行已停止，等待继续处理"}
        </p>
      )}
      {checkpoint?.modules.length ? (
        <>
          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
            已完成 {completedCount} / {checkpoint.modules.length} 个模块
          </p>
          <ol className="mt-3 grid gap-2 sm:grid-cols-2">
            {checkpoint.modules.map((module) => {
              const done = completed.has(module.id);
              const current = !done && module.id === checkpoint.currentModuleId;
              return (
                <li
                  key={module.id}
                  className="flex items-start justify-between gap-3 rounded-lg bg-white/70 px-3 py-2 text-xs dark:bg-zinc-900/60"
                >
                  <span className="min-w-0 break-words text-zinc-800 dark:text-zinc-200">
                    {module.title}
                  </span>
                  <span
                    className={`shrink-0 ${done ? "text-emerald-600 dark:text-emerald-400" : current ? "text-violet-600 dark:text-violet-400" : "text-zinc-400"}`}
                  >
                    {done
                      ? "已完成"
                      : current
                        ? task.status === "paused"
                          ? "已暂停"
                          : task.status === "failed" || checkpoint.phase === "blocked"
                            ? "待继续"
                            : task.status === "cancelled"
                              ? "已停止"
                              : "当前模块"
                        : "待执行"}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <p className="mt-2 text-xs text-zinc-500">
          {malformed ? "当前进度暂时无法确认，请查看任务记录。" : "正在等待模块计划。"}
        </p>
      )}
      <p className="mt-3 text-xs text-zinc-500">模块进度不代表最终验收结果</p>
      {checkpoint ? (
        <details className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
          <summary className="cursor-pointer text-zinc-500">连接与执行详情</summary>
          {request ? (
            <div
              aria-label="请求连接详情"
              className="mt-3 space-y-1 rounded-lg border border-violet-100 bg-white/70 p-3 text-xs text-zinc-600 dark:border-violet-500/20 dark:bg-zinc-900/60 dark:text-zinc-400"
            >
              <p className="font-medium text-zinc-800 dark:text-zinc-200">
                {request.type === "started"
                  ? "请求已发起，等待返回"
                  : request.type === "progress"
                    ? request.textChars > 0
                      ? "正在接收生成内容"
                      : "服务已响应 · 等待生成内容"
                    : request.type === "completed"
                      ? "最近请求已返回"
                      : "最近请求失败"}
              </p>
              <p className="break-all">
                提供方：{request.provider} · 模型：{request.model}
              </p>
              <p>
                {request.requestedBudget === undefined
                  ? "未设置平台输出上限"
                  : `历史请求输出上限 ${request.requestedBudget} tokens（非实际用量）`}
                {" · 第 "}
                {request.attempt} 次尝试
              </p>
              <p>
                {requestActive
                  ? `${request.type === "started" ? "已等待" : "请求已进行"} ${formatFullProjectDuration(requestState?.elapsedMs ?? request.durationMs)}`
                  : `已报告请求耗时 ${formatFullProjectDuration(request.durationMs)}`}
                {request.type !== "started" ? ` · 输出 ${request.textChars} 字符` : ""}
                {request.type === "failed"
                  ? ` · ${request.errorKind ? REQUEST_ERROR_LABELS[request.errorKind] : "失败原因未分类"}`
                  : ""}
                {request.type === "completed" && request.finishReason
                  ? ` · 结束原因：${request.finishReason}`
                  : ""}
              </p>
              {request.firstResponseMs !== undefined ? (
                <p>首段可识别内容耗时 {formatFullProjectDuration(request.firstResponseMs)}</p>
              ) : null}
              {request.inputTokens !== undefined ||
              request.outputTokens !== undefined ||
              request.reasoningTokens !== undefined ? (
                <p>
                  服务返回用量：
                  {[
                    request.inputTokens !== undefined ? `输入 ${request.inputTokens} tokens` : null,
                    request.outputTokens !== undefined
                      ? `输出 ${request.outputTokens} tokens`
                      : null,
                    request.reasoningTokens !== undefined
                      ? `推理 ${request.reasoningTokens} tokens`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
            </div>
          ) : null}
          {checkpoint &&
          !execution &&
          (checkpoint.modelCalls !== null || checkpoint.repairAttempts !== null) ? (
            <p className="mt-3 text-[11px] text-zinc-500">
              {checkpoint.modelCalls !== null ? `调用记录 ${checkpoint.modelCalls} 次` : ""}
              {checkpoint.modelCalls !== null && checkpoint.repairAttempts !== null ? " · " : ""}
              {checkpoint.repairAttempts !== null ? `修复尝试 ${checkpoint.repairAttempts} 次` : ""}
            </p>
          ) : null}
          {execution ? (
            <div className="mt-3 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
              <p>
                已记录运行时间 {formatFullProjectDuration(execution.elapsedMs)}
                （进程运行期间累计，停止后不增加）
              </p>
              <p>
                调用记录 {execution.modelCalls} 次 · 执行步骤 {execution.nextStepIndex} 步
                {checkpoint?.repairAttempts !== null && checkpoint?.repairAttempts !== undefined
                  ? ` · 自动修复 ${checkpoint.repairAttempts} 次`
                  : ""}
              </p>
            </div>
          ) : checkpoint ? (
            <p className="mt-3 text-xs text-zinc-500">运行计时或步骤计数未记录或无效。</p>
          ) : null}
          {checkpoint ? (
            <div className="mt-2 space-y-1 text-[11px] text-zinc-500">
              <p>
                {checkpoint.actualRequests !== null
                  ? `实际请求 ${checkpoint.actualRequests} 次`
                  : "实际请求计数未记录（旧检查点）"}
              </p>
            </div>
          ) : null}
          {stats && (stats.modelCalls > 0 || stats.steps > 0) ? (
            <div className="mt-3 space-y-1 text-[11px] text-zinc-500">
              <p>
                已记录返回调用耗时 {formatFullProjectDuration(stats.modelMs)}（{stats.modelCalls}{" "}
                次） · 已结束步骤耗时 {formatFullProjectDuration(stats.stepMs)}（{stats.steps} 步）
              </p>
              <p>
                {stats.lastModelMs !== null
                  ? `最近模型调用 ${formatFullProjectDuration(stats.lastModelMs)}`
                  : "最近模型调用耗时未记录"}
                {" · "}
                {stats.lastStepMs !== null
                  ? `最近执行步骤 ${formatFullProjectDuration(stats.lastStepMs)}`
                  : "最近步骤耗时未记录"}
              </p>
            </div>
          ) : null}
        </details>
      ) : null}
      {checkpoint?.error ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          任务暂未完成，请查看任务记录。
        </p>
      ) : null}
    </section>
  );
}
