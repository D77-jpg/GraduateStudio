"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import { AGENT_TASK_STATUS_LABELS, isActiveStatus, type AgentTaskDto } from "@/lib/agent";
import { formatFullProjectStepTitle } from "./full-project-progress";
import { parseCodexProgress } from "@/lib/codex-progress";
import {
  CHANGE_ACTION_LABELS,
  CHANGESET_STATUS_LABELS,
  type ActivityLogDto,
  type ChangeSetDto,
} from "@/lib/develop";

function elapsed(start: string, end: string | null, now: number) {
  const seconds = Math.max(
    0,
    Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000),
  );
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function TaskProcessPanel({ projectId, task }: { projectId: string; task: AgentTaskDto }) {
  const [tab, setTab] = useState<"activity" | "changes">("activity");
  const [now, setNow] = useState(() => Date.now());
  const active = isActiveStatus(task.status);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const logsQuery = useQuery({
    queryKey: ["agent-process-logs", projectId, task.id],
    queryFn: () => apiJson<{ logs: ActivityLogDto[] }>(`/api/projects/${projectId}/logs`),
    refetchInterval: active ? 3000 : false,
  });
  const changesQuery = useQuery({
    queryKey: ["agent-process-changes", projectId, task.id],
    queryFn: () => apiJson<{ changeSets: ChangeSetDto[] }>(`/api/projects/${projectId}/changesets`),
    refetchInterval: active ? 5000 : false,
  });
  const start = Date.parse(task.startedAt ?? task.createdAt);
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Infinity;
  const logs = (logsQuery.data?.logs ?? [])
    .filter((log) => Date.parse(log.createdAt) >= start && Date.parse(log.createdAt) <= end)
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const stepSetIds = new Set(task.steps.map((step) => step.changeSetId).filter(Boolean));
  const sets = (changesQuery.data?.changeSets ?? [])
    .filter(
      (set) =>
        stepSetIds.has(set.id) ||
        (set.source === "ai" &&
          Date.parse(set.createdAt) >= start &&
          Date.parse(set.createdAt) <= end),
    )
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const current = task.steps.find((step) => step.status === "running");
  const codex = task.steps.some((step) => step.title.startsWith("Codex："));
  const progress = parseCodexProgress(current?.detail ?? "");
  const files = new Set(sets.flatMap((set) => set.changes.map((change) => change.path)));
  const done = task.steps.filter((step) => step.status === "done").length;

  return (
    <section
      className="mt-5 border-t border-zinc-200 pt-5 dark:border-zinc-800"
      aria-label="开发过程"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">开发过程</h3>
          <p className="mt-1 text-xs text-zinc-500">
            {current
              ? formatFullProjectStepTitle(task, current.title)
              : AGENT_TASK_STATUS_LABELS[task.status]}
            {current ? ` · 已执行 ${elapsed(current.createdAt, current.finishedAt, now)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-zinc-500">
          <span>
            已完成步骤 <strong className="text-zinc-800 dark:text-zinc-200">{done}</strong>
          </span>
          <span>
            {codex ? "已应用文件" : "变更文件"}{" "}
            <strong className="text-zinc-800 dark:text-zinc-200">{files.size}</strong>
            {progress && (
              <span className="ml-3">
                副本已修改 <strong>{progress.files.length}</strong>（未应用）
              </span>
            )}
          </span>
          <span>任务耗时 {elapsed(task.startedAt ?? task.createdAt, task.finishedAt, now)}</span>
        </div>
      </div>
      {active && (
        <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50/50 px-3 py-3 text-xs leading-6 text-zinc-600 dark:border-blue-500/20 dark:bg-blue-500/5 dark:text-zinc-400">
          <span className="mr-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
          {codex
            ? progress?.latest ||
              "Codex 在隔离副本执行；下方计数仅代表已应用的文件，不代表副本没有修改。"
            : task.status === "coding" || task.status === "planning"
              ? "正在生成代码，完成校验后自动更新文件。"
              : "开发记录会自动更新，无需刷新页面。"}
          {progress?.model && (
            <p className="mt-1 text-[11px]">
              引擎 Codex CLI · 模型 {progress.model}
              {progress.updatedAt
                ? ` · 最近扫描 ${new Date(progress.updatedAt).toLocaleTimeString("zh-CN")}`
                : ""}{" "}
              · 等待模型时文件计数不会虚增
            </p>
          )}
          {progress && progress.files.length > 0 && (
            <div className="mt-2">
              <span>待审计的副本文件（未应用，非验收结果）：</span>
              <ul className="mt-1 font-mono">
                {progress.files.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div
        className="mt-4 flex items-center gap-5 border-b border-zinc-200 dark:border-zinc-800"
        role="tablist"
        aria-label="开发过程内容"
      >
        {(
          [
            { key: "activity", label: `活动日志 · ${logs.length}` },
            {
              key: "changes",
              label: `代码变更 · ${progress?.files.length ?? files.size} 个文件${progress ? "（副本）" : ""}`,
            },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`${task.id}-${item.key}-tab`}
            aria-controls={`${task.id}-${item.key}-panel`}
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
            className={`border-b-2 py-3 text-xs ${tab === item.key ? "border-blue-500 text-blue-600 dark:text-blue-400" : "border-transparent text-zinc-500"}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${task.id}-${tab}-panel`}
        aria-labelledby={`${task.id}-${tab}-tab`}
        className="mt-3"
      >
        {tab === "activity" ? (
          <>
            <p className="mb-3 text-[11px] leading-5 text-zinc-400">
              最新记录在前；这里也可能包含同一时段的手动操作。
            </p>
            {logsQuery.isError ? (
              <p className="py-4 text-xs text-red-500">
                日志读取失败，不影响任务执行。
                <button
                  type="button"
                  onClick={() => void logsQuery.refetch()}
                  className="ml-2 underline"
                >
                  重试
                </button>
              </p>
            ) : logsQuery.isPending ? (
              <p className="py-4 text-xs text-zinc-400">正在读取日志…</p>
            ) : logs.length === 0 ? (
              <p className="py-6 text-xs leading-6 text-zinc-500">
                暂未产生可展示的项目日志。当前步骤仍可从上方状态与耗时观察；生成结果返回后会更新记录。
              </p>
            ) : (
              <ol className="max-h-[420px] overflow-auto rounded-lg border border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                {logs.map((log) => (
                  <li
                    key={log.id}
                    className="border-b border-zinc-200/60 py-3 last:border-0 dark:border-zinc-800"
                  >
                    <div className="flex flex-wrap gap-2 text-xs">
                      <time className="font-mono text-zinc-400">
                        {new Date(log.createdAt).toLocaleTimeString("zh-CN")}
                      </time>
                      <span className="text-zinc-400">
                        {{ ai: "AI", terminal: "终端", file: "文件", system: "系统" }[log.kind]}
                      </span>
                      <span className="text-zinc-800 dark:text-zinc-200">
                        {formatFullProjectStepTitle(task, log.message)}
                      </span>
                    </div>
                    {log.detail && (
                      <details className="mt-2 text-xs text-zinc-500">
                        <summary className="cursor-pointer">查看详细记录</summary>
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-6 dark:text-zinc-400">
                          {log.detail}
                        </pre>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : (
          <>
            <p className="mb-3 text-[11px] leading-5 text-zinc-400">
              最新变更在前。展开文件可查看修改前后的内容；查看不会改变文件。
            </p>
            {progress && (
              <div className="mb-3 rounded-lg border p-3 text-xs">
                <p>隔离副本实际差异 · 尚未应用到原项目</p>
                {progress.files.length ? (
                  <ul className="mt-2 font-mono">
                    {progress.files.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2">暂未检测到文件修改；正在阅读或检查代码，不代表已开始修改。</p>
                )}
              </div>
            )}
            {changesQuery.isError ? (
              <p className="py-4 text-xs text-red-500">
                变更读取失败，不影响任务执行。
                <button
                  type="button"
                  onClick={() => void changesQuery.refetch()}
                  className="ml-2 underline"
                >
                  重试
                </button>
              </p>
            ) : changesQuery.isPending ? (
              <p className="py-4 text-xs text-zinc-400">正在读取变更…</p>
            ) : sets.length === 0 ? (
              <p className="py-6 text-xs leading-6 text-zinc-500">
                尚无已返回的代码变更。模型生成完成并保存后，这里将展示文件清单、实现说明和修改前后代码。
              </p>
            ) : (
              <div className="space-y-4">
                {sets.map((set) => (
                  <div
                    key={set.id}
                    className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                  >
                    <div className="flex flex-wrap justify-between gap-2 text-xs">
                      <h4 className="font-medium text-zinc-800 dark:text-zinc-200">
                        {formatFullProjectStepTitle(task, set.title)}
                      </h4>
                      <span className="text-zinc-500">
                        {CHANGESET_STATUS_LABELS[set.status]} · {set.changes.length} 个文件
                      </span>
                    </div>
                    {set.summary && (
                      <p className="mt-2 text-xs leading-6 text-zinc-500">{set.summary}</p>
                    )}
                    {set.plan.length > 0 && (
                      <details className="mt-3 text-xs">
                        <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
                          查看实现计划
                        </summary>
                        <ol className="mt-2 space-y-2">
                          {set.plan.map((item, index) => (
                            <li key={`${index}-${item.path}`} className="break-all text-zinc-500">
                              {index + 1}. {CHANGE_ACTION_LABELS[item.action]} {item.path}
                              {item.reason ? ` — ${item.reason}` : ""}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                    <div className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
                      {set.changes.map((change) => (
                        <details key={change.id} className="py-2">
                          <summary className="cursor-pointer break-all font-mono text-xs text-zinc-700 dark:text-zinc-300">
                            <span className="mr-2 text-blue-500">
                              {CHANGE_ACTION_LABELS[change.action]}
                            </span>
                            {change.path}
                          </summary>
                          <div className="mt-3 grid gap-3 lg:grid-cols-2">
                            {[
                              { label: "修改前", content: change.beforeContent },
                              { label: "修改后", content: change.afterContent },
                            ].map((side) => (
                              <div key={side.label} className="min-w-0">
                                <p className="mb-2 text-[11px] text-zinc-400">{side.label}</p>
                                <pre className="max-h-96 overflow-auto whitespace-pre rounded-md bg-zinc-950 p-3 font-mono text-[11px] leading-6 text-zinc-200">
                                  {side.content === null
                                    ? "（文件不存在）"
                                    : side.content || "（空文件）"}
                                </pre>
                              </div>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {task.gitCommitHash && (
        <p className="mt-4 text-xs text-zinc-500">
          已记录提交 <LinkToGit projectId={projectId} hash={task.gitCommitHash} />
        </p>
      )}
    </section>
  );
}

function LinkToGit({ projectId, hash }: { projectId: string; hash: string }) {
  return (
    <a href={`/projects/${projectId}/git`} className="font-mono text-blue-500 underline">
      {hash.slice(0, 7)}
    </a>
  );
}
