"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SparklesIcon } from "@/components/icons";

/** Phase 6:项目 Runtime 画布 —— 真实进程启动/停止/重启/构建 + Web 预览 + 控制台输出 + Debug 通道。 */

interface RuntimeStatus {
  status: "stopped" | "starting" | "running" | "exited" | "failed" | "building";
  port: number | null;
  pid: number | null;
  previewUrl: string | null;
  startedAt: number | null;
  uptimeSec: number | null;
  exitCode: number | null;
  building: boolean;
}

interface LogEntry {
  seq: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

const STATUS_LABEL: Record<string, string> = {
  stopped: "已停止",
  starting: "启动中",
  running: "运行中",
  exited: "已退出",
  failed: "运行失败",
  building: "构建中",
};

function statusTone(status: string): "success" | "accent" | "neutral" | "danger" {
  if (status === "running") return "success";
  if (status === "starting" || status === "building") return "accent";
  if (status === "failed") return "danger";
  return "neutral";
}

export function RuntimeView({ projectId }: { projectId: string }) {
  const [, setSince] = useState(0);
  const sinceRef = useRef(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<"console" | "problems">("console");
  const logBoxRef = useRef<HTMLDivElement>(null);

  const running = status?.status === "running";

  // 轮询循环:状态 + 增量日志(setState 在异步回调中,符合 lint 规则)
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const data = await apiJson<{ status: RuntimeStatus; logs?: LogEntry[]; nextSeq?: number }>(
          `/api/projects/${projectId}/runtime?logs=1&since=${sinceRef.current}`,
        );
        if (stopped) return;
        setStatus(data.status);
        if (data.logs && data.logs.length > 0) {
          setLogs((prev) => [...prev, ...data.logs!].slice(-1000));
        }
        if (data.nextSeq && data.nextSeq > sinceRef.current) {
          sinceRef.current = data.nextSeq;
          setSince(data.nextSeq);
        }
      } catch {
        // 轮询失败忽略,下一轮重试
      }
      if (!stopped) {
        timer = setTimeout(tick, 2000);
      }
    };
    void tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);

  // 日志自动滚到底
  useEffect(() => {
    logBoxRef.current?.scrollTo({ top: logBoxRef.current.scrollHeight });
  }, [logs.length, tab]);

  const control = useCallback(
    async (action: "start" | "stop" | "restart" | "build") => {
      setActionBusy(action);
      setActionError(null);
      try {
        await apiJson(`/api/projects/${projectId}/runtime?action=${action}`, { method: "POST" });
        // 立即轮询一次最新状态
        const data = await apiJson<{ status: RuntimeStatus; logs?: LogEntry[]; nextSeq?: number }>(
          `/api/projects/${projectId}/runtime?logs=1&since=${sinceRef.current}`,
        );
        setStatus(data.status);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "操作失败");
      } finally {
        setActionBusy(null);
      }
    },
    [projectId],
  );

  const errorLines = logs
    .filter((l) => l.stream === "stderr" || /error|failed|exception/i.test(l.text))
    .slice(-30);

  const createFixTask = useCallback(async () => {
    setActionBusy("fix");
    setActionError(null);
    try {
      const excerpt = errorLines
        .map((l) => `[${l.stream}] ${l.text}`)
        .join("\n")
        .slice(-4000);
      await apiJson(`/api/projects/${projectId}/agent-tasks`, {
        method: "POST",
        body: JSON.stringify({
          message: `修复项目运行错误。最近的运行输出如下(可能包含编译/运行时错误),请分析并修复相关代码:\n${excerpt || "(无明确错误输出,请检查项目是否能正常运行)"}`,
          maxSteps: 9,
        }),
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "发起修复任务失败");
    } finally {
      setActionBusy(null);
    }
  }, [errorLines, projectId]);

  const problems = logs.filter((l) => /error|failed|exception|cannot/i.test(l.text)).slice(-50);

  return (
    <div>
      {/* 顶部工具栏 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
        {status ? (
          <Badge tone={statusTone(status.status)}>
            {STATUS_LABEL[status.status] ?? status.status}
          </Badge>
        ) : (
          <span className="inline-block h-6 w-16 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
        )}
        {status?.port ? (
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
            :{status.port} · PID {status.pid ?? "-"} ·{" "}
            {status.uptimeSec !== null ? `${status.uptimeSec}s` : "-"}
          </span>
        ) : null}
        {status?.exitCode !== null &&
        status?.exitCode !== undefined &&
        status.status !== "running" ? (
          <span className="text-xs text-red-500">exit code {status.exitCode}</span>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!running ? (
            <Button size="sm" onClick={() => void control("start")} disabled={actionBusy !== null}>
              {actionBusy === "start" ? "启动中…" : "Run"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void control("stop")}
              disabled={actionBusy !== null}
            >
              {actionBusy === "stop" ? "停止中…" : "Stop"}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void control("restart")}
            disabled={actionBusy !== null || !status?.port}
          >
            {actionBusy === "restart" ? "重启中…" : "Restart"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void control("build")}
            disabled={actionBusy !== null}
          >
            {status?.building ? "构建中…" : "Build"}
          </Button>
          {running && status?.previewUrl ? (
            <a
              href={status.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              新窗口打开 ↗
            </a>
          ) : null}
          {errorLines.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void createFixTask()}
              disabled={actionBusy !== null}
              title="把最近的错误输出交给 Agent 自动修复"
            >
              <SparklesIcon className="h-3.5 w-3.5" />
              {actionBusy === "fix" ? "发起中…" : "AI 修复"}
            </Button>
          ) : null}
        </div>
      </div>

      {actionError ? (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-400">
          {actionError}
        </p>
      ) : null}

      {/* 预览区 */}
      <div className="mt-4 h-[52vh] overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {running && status?.previewUrl ? (
          <iframe
            key={status.previewUrl}
            src={status.previewUrl}
            title="项目预览"
            className="h-full w-full"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {status?.status === "starting" || status?.status === "building"
                ? "项目启动/构建中,请稍候…(首次会自动安装依赖)"
                : status?.status === "failed"
                  ? "项目运行失败,请查看下方控制台输出"
                  : status?.status === "exited"
                    ? `进程已退出(exit code ${status.exitCode}),点击 Run 重新启动`
                    : "项目未运行"}
            </p>
            {!running ? (
              <Button
                size="sm"
                onClick={() => void control("start")}
                disabled={actionBusy !== null}
              >
                Run
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {/* 底部:Console / Problems */}
      <div className="mt-4 rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="flex h-9 items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
          {(
            [
              { key: "console", label: `控制台输出(${logs.length})` },
              { key: "problems", label: `问题(${problems.length})` },
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
          <button
            type="button"
            onClick={() => setLogs([])}
            className="ml-auto rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            清空显示
          </button>
        </div>
        <div
          ref={logBoxRef}
          className="h-52 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
        >
          {tab === "console" ? (
            logs.length === 0 ? (
              <p className="text-zinc-400">
                暂无输出;点击 Run 启动项目后,这里显示真实的进程 stdout/stderr。
              </p>
            ) : (
              logs.map((l) => (
                <div key={l.seq} className="flex gap-2">
                  <span
                    className={
                      l.stream === "stderr"
                        ? "text-red-400"
                        : l.stream === "system"
                          ? "text-violet-400"
                          : "text-zinc-300 dark:text-zinc-600"
                    }
                  >
                    {l.stream === "stderr" ? "stderr" : l.stream === "system" ? "sys" : "out"}
                  </span>
                  <span
                    className={`whitespace-pre-wrap ${
                      l.stream === "stderr"
                        ? "text-red-600 dark:text-red-400"
                        : l.stream === "system"
                          ? "text-violet-600 dark:text-violet-400"
                          : "text-zinc-700 dark:text-zinc-300"
                    }`}
                  >
                    {l.text}
                  </span>
                </div>
              ))
            )
          ) : problems.length === 0 ? (
            <p className="text-zinc-400">未检测到错误输出;构建与运行错误会显示在这里。</p>
          ) : (
            problems.map((l, i) => (
              <p key={i} className="whitespace-pre-wrap text-red-600 dark:text-red-400">
                {l.text}
              </p>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
