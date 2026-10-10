"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import {
  AGENT_STEP_KIND_LABELS,
  AGENT_TASK_STATUS_LABELS,
  isActiveStatus,
  type AgentStepDto,
  type AgentTaskDto,
  type AgentTaskStatus,
} from "@/lib/agent";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Skeleton } from "@/components/ui/skeleton";
import { SparklesIcon } from "@/components/icons";

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

function StepLine({ step }: { step: AgentStepDto }) {
  const icon =
    step.status === "running"
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
          className={`text-sm ${step.status === "failed" ? "text-red-600 dark:text-red-400" : "text-zinc-800 dark:text-zinc-200"}`}
        >
          {step.title}
          <span className="ml-2 text-[11px] text-zinc-400">{kindLabel}</span>
          {step.status === "running" ? (
            <span className="ml-2 animate-pulse text-[11px] text-violet-500">执行中…</span>
          ) : null}
        </p>
        {step.detail ? (
          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-zinc-50 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
            {step.detail}
          </pre>
        ) : null}
      </div>
    </li>
  );
}

function TaskCard({
  projectId,
  task,
  onChanged,
}: {
  projectId: string;
  task: AgentTaskDto;
  onChanged: () => void;
}) {
  const running = isActiveStatus(task.status);
  const [errorOpen, setErrorOpen] = useState(task.status === "failed");

  async function control(action: "pause" | "resume" | "cancel") {
    try {
      await apiJson(`/api/projects/${projectId}/agent-tasks/${task.id}/control`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      onChanged();
    } catch {
      onChanged();
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
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={STATUS_TONE[task.status]}>{AGENT_TASK_STATUS_LABELS[task.status]}</Badge>
          {running ? (
            <>
              {task.status !== "paused" ? (
                <Button size="sm" variant="secondary" onClick={() => void control("pause")}>
                  暂停
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => void control("resume")}>
                  恢复
                </Button>
              )}
              <ConfirmButton
                size="sm"
                confirmLabel="确认取消?"
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
        maxSteps {task.maxSteps}
      </p>

      <ol className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
        {task.steps.map((step) => (
          <StepLine key={step.id} step={step} />
        ))}
        {running && task.steps.length === 0 ? (
          <li className="py-2 text-sm text-zinc-400">任务启动中…</li>
        ) : null}
      </ol>

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
        <p className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">
          ✓ 任务完成。代码变更已应用,可在
          <Link
            href={`/projects/${projectId}/develop`}
            className="mx-1 underline underline-offset-4"
          >
            开发工作区
          </Link>
          的变更历史中查看或撤销。
        </p>
      ) : null}
      {task.status === "paused" ? (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          任务已暂停;恢复后将从当前步骤继续。
        </p>
      ) : null}
    </div>
  );
}

export function AgentTasksView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [maxSteps, setMaxSteps] = useState(12);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tasksQuery = useQuery({
    queryKey: ["agent-tasks", projectId],
    queryFn: () =>
      apiJson<{ tasks: AgentTaskDto[]; anyRunning: boolean }>(
        `/api/projects/${projectId}/agent-tasks`,
      ),
    // 有运行中任务时 2 秒轮询,否则 15 秒
    refetchInterval: (query) =>
      (query.state.data?.tasks ?? []).some((t) => isActiveStatus(t.status)) ? 2000 : 15000,
  });

  const tasks = tasksQuery.data?.tasks ?? [];
  const runningTask = tasks.find((t) => isActiveStatus(t.status));

  // 运行中任务变化时同步工作区相关数据
  useEffect(() => {
    if (runningTask && (runningTask.status === "coding" || runningTask.status === "fixing")) {
      void queryClient.invalidateQueries({ queryKey: ["changesets", projectId] });
    }
  }, [runningTask?.status, runningTask, projectId, queryClient]);

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiJson(`/api/projects/${projectId}/agent-tasks`, {
        method: "POST",
        body: JSON.stringify({ message, maxSteps }),
      });
      setMessage("");
      await queryClient.invalidateQueries({ queryKey: ["agent-tasks", projectId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "发起失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      {/* 发起任务 */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          发起自主开发任务
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          Agent 将自动执行:分析项目 → 制定计划 → 生成代码(应用为变更集)→ 依赖安装 → 语法自检 →
          自动修复(有上限)→ 输出结果。每步落库可追踪,可随时暂停/取消。
        </p>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="例如:实现用户登录、注册和 JWT 鉴权"
          className="mt-3 w-full resize-none rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            onClick={() => void submit()}
            disabled={submitting || !message.trim() || Boolean(runningTask)}
          >
            <SparklesIcon className="h-4 w-4" />
            {submitting ? "启动中…" : "启动任务"}
          </Button>
          <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            执行步数上限
            <select
              value={maxSteps}
              onChange={(event) => setMaxSteps(Number(event.target.value))}
              className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            >
              {[6, 9, 12, 18, 24].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {runningTask ? (
            <span className="text-xs text-amber-600 dark:text-amber-400">已有任务在运行中</span>
          ) : null}
        </div>
        {error ? (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </div>

      {/* 任务列表 */}
      <div className="mt-6 space-y-4">
        {tasksQuery.isPending ? (
          <Skeleton className="h-40 rounded-lg" />
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
