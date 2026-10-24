"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import {
  AGENT_STEP_KIND_LABELS,
  AGENT_TASK_STATUS_LABELS,
  isActiveStatus,
  effectiveAgentSteps,
  type AgentStepDto,
  type AgentTaskDto,
  type AgentTaskStatus,
} from "@/lib/agent";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Skeleton } from "@/components/ui/skeleton";
import { SparklesIcon } from "@/components/icons";
import { TaskProcessPanel } from "./task-process-panel";
import { parseCodexProgress } from "@/lib/codex-progress";
import { AcceptanceReport, readTaskAcceptanceReport } from "./acceptance-report";
import { RuntimeRepairReport } from "./runtime-repair-report";
import { DesignReport } from "./design-report";
import { InvestigationDetail } from "./investigation-detail";
import {
  agentStepDetailDisplay,
  latestVisibleAgentSteps,
  groupAgentSteps,
  isSafeBatchSplitStep,
  type AgentStepGroup,
} from "@/lib/agent-display";
import {
  FullProjectProgress,
  formatFullProjectStepTitle,
  isFullProjectTask,
  readFullProjectCheckpoint,
} from "./full-project-progress";

const STATUS_TONE: Record<AgentTaskStatus, "accent" | "success" | "neutral" | "danger"> = {
  queued: "neutral",
  analyzing: "accent",
  planning: "accent",
  coding: "accent",
  checking: "accent",
  fixing: "accent",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
  paused: "neutral",
};

const STEP_ICON: Record<string, string> = {
  analyze: "🔍",
  plan: "📋",
  code: "⌨️",
  install: "📦",
  check: "🧪",
  fix: "🔧",
  note: "ℹ️",
};

function StepLine({ step, task }: { step: AgentStepDto; task: AgentTaskDto }) {
  const detail = agentStepDetailDisplay(step);
  const codexProgress = parseCodexProgress(step.detail);
  const split = isSafeBatchSplitStep(step);
  const icon = split
    ? "↳"
    : step.status === "running"
      ? "⏳"
      : step.status === "failed"
        ? "✕"
        : (STEP_ICON[step.kind] ?? "•");
  const kindLabel = AGENT_STEP_KIND_LABELS[step.kind] ?? step.kind;
  return (
    <li className="flex gap-2.5 py-1.5">
      <span className="w-5 shrink-0 text-center text-sm">{icon}</span>
      <div className="min-w-0 flex-1">
        <p
          className={`text-sm ${step.status === "failed" && !split ? "text-red-600 dark:text-red-400" : "text-zinc-800 dark:text-zinc-200"}`}
        >
          {formatFullProjectStepTitle(task, step.title)}
          <span className="ml-2 text-[11px] text-zinc-400">{kindLabel}</span>
          {step.status === "running" ? (
            <span className="ml-2 animate-pulse text-[11px] text-violet-500">执行中…</span>
          ) : null}
        </p>
        <p className="mt-1 text-[11px] text-zinc-400">
          {new Date(step.createdAt).toLocaleTimeString("zh-CN")}
          {step.finishedAt
            ? ` → ${new Date(step.finishedAt).toLocaleTimeString("zh-CN")}`
            : step.status === "running"
              ? " · 等待本步结果"
              : ""}
          {split
            ? " · 已自动拆分"
            : step.status === "done"
              ? " · 已完成"
              : step.status === "skipped"
                ? " · 已跳过"
                : ""}
        </p>
        {!step.detail.trim() && step.status === "done" ? (
          <p className="mt-1 text-[11px] text-zinc-400">
            {step.kind === "diagnostic"
              ? "该步骤为只读调查；工具观察与调查结论请查看相邻步骤，本步不产生代码变更。"
              : "该步骤未保存详细输出；文件结果可在下方代码变更中查看。"}
          </p>
        ) : null}
        {codexProgress ? (
          <p className="mt-2 text-xs text-zinc-500">
            {codexProgress.latest} · 副本修改 {codexProgress.files.length} 个文件（未应用）
          </p>
        ) : step.kind === "diagnostic" && step.detail.trim() ? (
          <InvestigationDetail detail={step.detail} />
        ) : detail.kind === "text" ? (
          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-zinc-50 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
            {detail.text}
          </pre>
        ) : detail.kind === "plan" ? (
          <div className="mt-1 rounded-lg bg-zinc-50 px-2.5 py-2 text-xs leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300">
            <p className="whitespace-pre-wrap break-words">{detail.summary}</p>
            <p className="mt-1 text-[11px] text-zinc-500">{detail.countLabel}</p>
            {detail.items.length ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] font-medium">查看计划明细</summary>
                <ul className="mt-2 max-h-56 space-y-2 overflow-y-auto">
                  {detail.items.map((item, index) => (
                    <li key={index}>
                      <p className="break-all font-medium">{item.title}</p>
                      {item.description ? (
                        <p className="break-words text-zinc-500">{item.description}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function StepGroup({ group, task }: { group: AgentStepGroup; task: AgentTaskDto }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  return (
    <li className="py-2">
      <details open={manualOpen ?? group.defaultOpen}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            setManualOpen(!(manualOpen ?? group.defaultOpen));
          }}
          className="cursor-pointer rounded-lg bg-zinc-50 px-3 py-3 text-sm dark:bg-zinc-800/40"
        >
          <span className="font-medium text-zinc-800 dark:text-zinc-200">{group.title}</span>
          <span className="ml-3 text-xs text-zinc-500">
            {group.steps.length} 条记录 ·{" "}
            {
              { running: "进行中", failed: "需要处理", done: "已完成", recorded: "已记录" }[
                group.status
              ]
            }
          </span>
        </summary>
        <ol className="mt-2 divide-y divide-zinc-100 pl-3 dark:divide-zinc-800">
          {group.steps.map((step) => (
            <StepLine key={step.id} step={step} task={task} />
          ))}
        </ol>
      </details>
    </li>
  );
}

function TaskCard({
  projectId,
  task,
  inProcess,
  onChanged,
}: {
  projectId: string;
  task: AgentTaskDto;
  inProcess: boolean | undefined;
  onChanged: () => void;
}) {
  const running = isActiveStatus(task.status);
  const fullProject = isFullProjectTask(task);
  const displaySteps = effectiveAgentSteps(task);
  const visibleSteps = latestVisibleAgentSteps(displaySteps);
  const checkpoint = readFullProjectCheckpoint(task);
  const groups = groupAgentSteps(displaySteps, checkpoint?.modules, checkpoint?.completedModuleIds);
  const codex = task.execution?.engine === "codex";
  const plan = task.execution?.plan ?? null;
  const awaitingReview = task.execution?.phase === "awaiting_acceptance";
  const appliedUnverified = task.execution?.phase === "applied_unverified";
  const reviewOnly = awaitingReview || appliedUnverified;
  const acceptance = readTaskAcceptanceReport(displaySteps);
  const engineeringStatus = acceptance.kind === "report" ? acceptance.report.status : null;
  const engineeringPassed = appliedUnverified && !running && engineeringStatus === "passed";
  const appliedLabel = running
    ? "工程检查中"
    : engineeringPassed
      ? "工程通过 · 待业务验收"
      : engineeringStatus === "failed"
        ? "工程检查未通过"
        : engineeringStatus === "blocked" || acceptance.kind === "invalid"
          ? "工程检查受阻"
          : "已应用 · 待验收";
  const canRetry =
    (codex ? task.execution?.resumable === true : fullProject) &&
    inProcess === false &&
    task.status !== "completed" &&
    task.status !== "cancelled";
  const canDiagnoseRuntime =
    !running &&
    /(?:任务|\btask\b)\s*#?\s*[1-9]\d*/i.test(task.message) &&
    /修复|修好|修一下|排查|解决|失败|错误|超时|无法连接|连不上|repair|debug|fix|fail|error|refused|timeout|diagnos/i.test(
      task.message,
    );
  const [errorOpen, setErrorOpen] = useState(task.status === "failed");
  const [processOpen, setProcessOpen] = useState(running || task.status === "failed");
  const [controlling, setControlling] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);

  async function control(action: "pause" | "resume" | "cancel" | "retry" | "verify") {
    if (controlling) return;
    setControlling(true);
    setControlError(null);
    try {
      await apiJson(`/api/projects/${projectId}/agent-tasks/${task.id}/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      onChanged();
    } catch (err) {
      setControlError(err instanceof Error ? err.message : "操作失败，请稍后重试");
      onChanged();
    } finally {
      setControlling(false);
    }
  }

  async function diagnoseRuntime() {
    if (controlling || !canDiagnoseRuntime) return;
    setControlling(true);
    setControlError(null);
    try {
      await apiJson(`/api/projects/${projectId}/agent-tasks/${task.id}/diagnose`, {
        method: "POST",
      });
      onChanged();
    } catch (err) {
      setControlError(err instanceof Error ? err.message : "运行故障复核失败，请稍后重试");
      onChanged();
    } finally {
      setControlling(false);
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            <SparklesIcon className="h-4 w-4 shrink-0 text-violet-500" />
            <span className="truncate">{task.title || task.message.slice(0, 40)}</span>
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
            {task.message}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Badge tone={engineeringPassed ? "success" : STATUS_TONE[task.status]}>
            {awaitingReview
              ? "等待代码审核"
              : appliedUnverified
                ? appliedLabel
                : task.status === "checking"
                  ? "工程验收中"
                  : AGENT_TASK_STATUS_LABELS[task.status]}
          </Badge>
          {engineeringPassed ? (
            <Link
              href={`/projects/${projectId}/run`}
              className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              运行与预览
            </Link>
          ) : null}
          {appliedUnverified && !running ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={controlling}
              onClick={() => void control("verify")}
            >
              {engineeringStatus || acceptance.kind === "invalid" ? "重新检查" : "开始工程检查"}
            </Button>
          ) : null}
          {canDiagnoseRuntime ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={controlling}
              title="仅收集运行诊断，不重试业务任务、不调用模型，也不改变任务状态。"
              onClick={() => void diagnoseRuntime()}
            >
              运行故障复核（不调用模型）
            </Button>
          ) : null}
          {canRetry ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={controlling}
              onClick={() => void control("retry")}
            >
              从断点继续
            </Button>
          ) : null}
          {appliedUnverified && task.status === "paused" ? (
            <ConfirmButton
              size="sm"
              confirmLabel="结束任务（不撤销文件）？"
              disabled={controlling}
              onConfirm={() => void control("cancel")}
            >
              结束开发任务（业务未验收）
            </ConfirmButton>
          ) : null}
          {!reviewOnly && (running || task.status === "paused") ? (
            <>
              {task.status !== "paused" && !canRetry ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={controlling}
                  onClick={() => void control("pause")}
                >
                  暂停
                </Button>
              ) : task.status === "paused" && !codex && (!fullProject || inProcess === true) ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={controlling}
                  onClick={() => void control("resume")}
                >
                  {fullProject ? "从断点继续" : "恢复"}
                </Button>
              ) : null}
              <ConfirmButton
                size="sm"
                confirmLabel="确认取消?"
                disabled={controlling}
                onConfirm={() => void control("cancel")}
              >
                取消
              </ConfirmButton>
            </>
          ) : null}
        </div>
      </div>

      <p className="mt-1 text-[11px] text-zinc-400">
        创建于 {new Date(task.createdAt).toLocaleString("zh-CN")} · 修复尝试 {task.fixAttempts} 次 ·
        已记录 {visibleSteps.length} 步
      </p>

      {controlError ? (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {controlError}
        </p>
      ) : null}
      {codex ? (
        <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/50 p-4 text-sm dark:border-blue-900 dark:bg-blue-950/20">
          <p className="font-medium">
            {running && appliedUnverified
              ? "正在验证已应用的代码"
              : appliedUnverified
                ? engineeringPassed
                  ? "工程检查已通过，待业务验收"
                  : engineeringStatus === "failed"
                    ? "工程检查未通过，请查看下方失败项"
                    : engineeringStatus === "blocked" || acceptance.kind === "invalid"
                      ? "工程检查受阻，请查看下方原因"
                      : "文件已应用，尚未执行工程检查"
                : awaitingReview
                  ? "开发执行已结束，等待确认文件变更"
                  : running
                    ? "正在开发项目"
                    : "项目开发记录"}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {appliedUnverified
              ? engineeringPassed
                ? "已配置的工程检查已通过，无需重复检查。下一步进入运行与预览，验证关键业务流程；跳过项不代表通过，业务验收尚未完成。"
                : running
                  ? "正在独立副本中运行工程检查，不会修改已应用文件或自动调用模型；完成后更新下方报告。"
                  : "工程检查在独立副本中运行，不会修改已应用文件或自动调用模型。请查看下方报告；修复代码或环境后可重新检查。"
              : "模块执行记录见下方日志；开发执行结束不代表项目验收通过。"}
          </p>
          {plan ? (
            <div className="mt-3 rounded-xl border border-zinc-200 bg-white/60 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
              <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                模块进度 {plan.done} / {plan.total}
              </p>
              <ol className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {plan.modules.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300">
                      {item.title}
                    </span>
                    <span
                      className={
                        item.status === "done"
                          ? "shrink-0 text-emerald-600 dark:text-emerald-400"
                          : item.status === "current"
                            ? "shrink-0 text-blue-600 dark:text-blue-400"
                            : "shrink-0 text-zinc-400"
                      }
                    >
                      {item.status === "done"
                        ? "已完成"
                        : item.status === "current"
                          ? "进行中"
                          : "待执行"}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      ) : (
        <FullProjectProgress task={task} />
      )}
      <AcceptanceReport task={task} />
      <RuntimeRepairReport task={task} />
      <DesignReport task={task} />

      <p className="mt-3 text-[11px] text-zinc-400">开发日志 · 最新在前</p>
      <ol className="mt-1 divide-y divide-zinc-100 dark:divide-zinc-800">
        {groups.map((group) =>
          group.id.startsWith("module:") ? (
            <StepGroup key={group.id} group={group} task={task} />
          ) : (
            <StepLine key={group.id} step={group.steps[0]} task={task} />
          ),
        )}
        {running && visibleSteps.length === 0 ? (
          <li className="py-2 text-sm text-zinc-400">任务启动中…</li>
        ) : null}
      </ol>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-3"
        aria-expanded={processOpen}
        onClick={() => setProcessOpen((value) => !value)}
      >
        {processOpen ? "收起开发过程" : "查看日志与代码变更"}
      </Button>
      {processOpen ? <TaskProcessPanel projectId={projectId} task={task} /> : null}

      {task.status === "failed" && task.error ? (
        <div className="mt-3">
          <button
            type="button"
            className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
            onClick={() => setErrorOpen((v) => !v)}
          >
            {errorOpen ? "收起错误上下文" : "展开错误上下文"}
          </button>
          {errorOpen ? (
            <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
              {task.error}
            </pre>
          ) : null}
        </div>
      ) : null}

      {task.status === "completed" ? (
        <p className="mt-3 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
          任务执行已结束。工程检查结果以上方验收报告为准，不代表业务功能完整或项目可交付。代码变更可在
          <Link
            href={`/projects/${projectId}/develop`}
            className="mx-1 underline underline-offset-4"
          >
            开发工作区
          </Link>
          的变更历史中查看或撤销。
        </p>
      ) : null}
      {canRetry ? (
        <p className="mt-3 text-xs text-zinc-500">
          {codex
            ? "从应用检查点启动新的执行尝试，不保证延续原模型会话；模型调用可能产生费用。"
            : "从已保存进度继续，不重做已完成模块；继续模型调用可能产生费用。"}
        </p>
      ) : null}
      {reviewOnly ? (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          {awaitingReview
            ? "副本变更尚未应用，请在开发工作区审核。不会再次调用模型。"
            : engineeringPassed
              ? "工程检查已通过；业务功能、外部服务联通及用户流程仍需在运行环境中验收。"
              : running
                ? "文件已应用，工程检查正在执行；请等待本次检查结果。"
                : engineeringStatus || acceptance.kind === "invalid"
                  ? "文件已应用，请依据最新报告处理失败或受阻项；工程检查不等于业务验收。"
                  : "文件已应用，但尚未执行工程检查，不代表功能完整或可交付。"}
          <Link className="ml-1 underline" href={`/projects/${projectId}/develop`}>
            查看代码变更
          </Link>
        </p>
      ) : null}
      {task.status === "paused" && !reviewOnly ? (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          {codex
            ? inProcess
              ? "正在停止原执行，请等待退出后再继续。"
              : "执行已停止，可从应用检查点发起新尝试。"
            : fullProject
              ? "任务已暂停。点击「从断点继续」后恢复，不会在打开页面时自动启动。"
              : "任务已暂停;恢复后将从当前步骤继续。"}
        </p>
      ) : null}
    </div>
  );
}

export function AgentTasksView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tasksQuery = useQuery({
    queryKey: ["agent-tasks", projectId],
    queryFn: () =>
      apiJson<{ tasks: AgentTaskDto[]; anyRunning: boolean; runningTaskIds: string[] }>(
        `/api/projects/${projectId}/agent-tasks`,
      ),
    // 有运行中任务时 2 秒轮询,否则 15 秒
    refetchInterval: (query) =>
      (query.state.data?.tasks ?? []).some((t) => isActiveStatus(t.status)) ? 2000 : 15000,
  });

  const tasks = tasksQuery.data?.tasks ?? [];
  const runningTask = tasks.find((t) => isActiveStatus(t.status));
  const busy =
    Boolean(tasksQuery.data?.anyRunning) ||
    Boolean(runningTask) ||
    tasks.some((task) => task.status === "paused");

  // 运行中任务变化时同步工作区相关数据
  useEffect(() => {
    if (runningTask && (runningTask.status === "coding" || runningTask.status === "fixing")) {
      void queryClient.invalidateQueries({ queryKey: ["changesets", projectId] });
    }
  }, [runningTask?.status, runningTask, projectId, queryClient]);

  async function submit(mode: "full" | "local") {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiJson(`/api/projects/${projectId}/agent-tasks`, {
        method: "POST",
        body: JSON.stringify(mode === "full" ? { mode: "full" } : { message }),
      });
      if (mode === "local") setMessage("");
      await queryClient.invalidateQueries({ queryKey: ["agent-tasks", projectId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "发起失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      {/* 发起任务 */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">生成完整项目</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          根据已保存的需求与功能清单开发项目，并检查生成结果。你可以随时查看进度、暂停或取消任务。
        </p>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          生成的代码需经你审核后应用。模型调用可能持续产生费用，不保证项目完成或耗时；应用后请验证实际功能。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            onClick={() => void submit("full")}
            disabled={submitting || busy || tasksQuery.isPending || tasksQuery.isError}
          >
            <SparklesIcon className="h-4 w-4" />
            {submitting ? "启动中…" : "生成完整项目"}
          </Button>
          {busy ? (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              已有任务运行或暂停中，请先继续处理或取消
            </span>
          ) : null}
        </div>
        {tasksQuery.isError ? (
          <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
            任务状态加载失败，请刷新后重试。
          </p>
        ) : null}
        <details className="mt-5 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <summary className="cursor-pointer text-sm font-medium text-zinc-600 dark:text-zinc-300">
            修改指定功能
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            仅修改指定功能时，可输入任务说明。
          </p>
          <textarea
            aria-label="局部任务说明"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="例如:实现用户登录、注册和 JWT 鉴权"
            className="mt-3 w-full resize-none rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void submit("local")}
              disabled={
                submitting || !message.trim() || busy || tasksQuery.isPending || tasksQuery.isError
              }
            >
              <SparklesIcon className="h-4 w-4" />
              {submitting ? "启动中…" : "启动局部任务"}
            </Button>
            {busy ? (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                已有任务运行或暂停中
              </span>
            ) : null}
          </div>
        </details>
        {error ? (
          <p
            role="alert"
            className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-400"
          >
            {error}
          </p>
        ) : null}
      </div>

      {/* 任务列表 */}
      <div className="mt-6 space-y-4">
        {tasksQuery.isPending ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : tasksQuery.isError && tasks.length === 0 ? (
          <div
            role="alert"
            className="rounded-2xl border border-red-200 p-6 text-center text-sm dark:border-red-900"
          >
            <p>任务列表暂时无法加载，不代表任务已丢失。请勿重复创建任务。</p>
            <Button className="mt-3" onClick={() => void tasksQuery.refetch()}>
              重新加载任务
            </Button>
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-400 dark:border-zinc-700">
            还没有任务;发起第一个自主开发任务吧。
          </div>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              projectId={projectId}
              task={task}
              inProcess={tasksQuery.data?.runningTaskIds?.includes(task.id)}
              onChanged={() =>
                void queryClient.invalidateQueries({ queryKey: ["agent-tasks", projectId] })
              }
            />
          ))
        )}
      </div>
    </div>
  );
}
