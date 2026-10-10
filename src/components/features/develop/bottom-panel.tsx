"use client";

import { useState } from "react";
import type { ActivityLogDto, TerminalRunDto } from "@/lib/develop";
import { apiJson } from "@/lib/api-client";

type BottomTab = "terminal" | "logs" | "problems";

export function BottomPanel({
  projectId,
  logs,
  onActivity,
}: {
  projectId: string;
  logs: ActivityLogDto[];
  onActivity: () => void;
}) {
  const [tab, setTab] = useState<BottomTab>("terminal");
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<TerminalRunDto[]>([]);

  async function runCommand() {
    const cmd = command.trim();
    if (!cmd || running) return;
    setRunning(true);
    setCommand("");
    try {
      const data = await apiJson<{ run: TerminalRunDto }>(`/api/projects/${projectId}/terminal`, {
        method: "POST",
        body: JSON.stringify({ command: cmd }),
      });
      setRuns((prev) => [...prev, data.run]);
      onActivity();
    } catch (error) {
      setRuns((prev) => [
        ...prev,
        {
          command: cmd,
          exitCode: 1,
          timedOut: false,
          output: error instanceof Error ? error.message : "执行失败",
          durationMs: 0,
        },
      ]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex h-56 shrink-0 flex-col border-t border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
        {(
          [
            { key: "terminal", label: "终端" },
            { key: "logs", label: "日志" },
            { key: "problems", label: "问题" },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              tab === key
                ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "terminal" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed">
            {runs.length === 0 ? (
              <p className="text-zinc-400">
                在项目工作区中执行命令(如 node -v、npm install);危险删除/格式化命令会被拦截。
              </p>
            ) : (
              runs.map((run, index) => (
                <div key={index} className="mb-3">
                  <p className="text-zinc-500 dark:text-zinc-400">
                    <span className="text-violet-600 dark:text-violet-400">$</span> {run.command}
                    <span className="ml-2 text-zinc-400">
                      exit={run.exitCode ?? "?"} · {(run.durationMs / 1000).toFixed(1)}s
                    </span>
                  </p>
                  <pre className="mt-1 whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">
                    {run.output}
                  </pre>
                </div>
              ))
            )}
            {running ? <p className="text-zinc-400">执行中…</p> : null}
          </div>
          <div className="flex h-9 shrink-0 items-center gap-2 border-t border-zinc-200 px-3 dark:border-zinc-800">
            <span className="font-mono text-xs text-violet-600 dark:text-violet-400">$</span>
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void runCommand();
              }}
              placeholder="输入命令,回车执行"
              disabled={running}
              className="h-full flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-zinc-400"
            />
          </div>
        </div>
      ) : null}

      {tab === "logs" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-xs">
          {logs.length === 0 ? (
            <p className="text-zinc-400">暂无活动日志</p>
          ) : (
            logs.map((log) => (
              <div
                key={log.id}
                className="border-b border-zinc-100 py-1.5 last:border-b-0 dark:border-zinc-800"
              >
                <p className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      log.kind === "ai"
                        ? "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
                        : log.kind === "terminal"
                          ? "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                          : "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                    }`}
                  >
                    {log.kind}
                  </span>
                  <span className="text-zinc-800 dark:text-zinc-200">{log.message}</span>
                  <span className="ml-auto shrink-0 text-zinc-400">
                    {new Date(log.createdAt).toLocaleTimeString("zh-CN")}
                  </span>
                </p>
                {log.detail ? (
                  <pre className="mt-1 whitespace-pre-wrap pl-9 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                    {log.detail}
                  </pre>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}

      {tab === "problems" ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-zinc-400">
          问题面板将在 Agent 自动执行 typecheck / 测试后填充(Phase
          5-7:自动开发闭环会收集编译与测试错误)。
        </div>
      ) : null}
    </div>
  );
}
