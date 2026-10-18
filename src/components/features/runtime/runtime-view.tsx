"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/api-client";
import { buildRuntimeFixMessage } from "@/lib/runtime-fix";
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
  ready?: boolean;
  backend?: {
    managed: boolean;
    target: string;
    pid: number | null;
    status: "starting" | "running" | "failed" | "stopped";
    ready: boolean;
    error: string | null;
    healthScope: "http" | "services";
    stack?: "python";
    services?: Array<{
      name: string;
      status: "starting" | "running" | "failed" | "stopped";
    }>;
  } | null;
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
  const [previewLogin, setPreviewLogin] = useState<{
    projectId: string;
    username: string;
    password: string;
  } | null>(null);
  const [previewLoginBusy, setPreviewLoginBusy] = useState(false);
  const previewLoginInFlight = useRef(false);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const actionInFlight = useRef(false);
  const [stopBusy, setStopBusy] = useState(false);
  const stopInFlight = useRef(false);
  const controlRevision = useRef(0);

  const running = status?.status === "running";
  const preparing =
    status?.status === "starting" ||
    status?.status === "building" ||
    status?.building === true ||
    status?.backend?.status === "starting";
  const starting = preparing || actionBusy === "start" || actionBusy === "restart";
  const pythonStack =
    status?.backend?.managed === true &&
    status.backend.stack === "python" &&
    status.backend.healthScope === "services";
  const pythonReady =
    pythonStack &&
    running &&
    status?.ready !== false &&
    status?.backend?.ready === true &&
    status.backend.status === "running" &&
    !status.backend.services?.some((service) => service.status !== "running");

  // 轮询循环:状态 + 增量日志(setState 在异步回调中,符合 lint 规则)
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const revision = controlRevision.current;
      const pollingDuringStop = stopInFlight.current;
      try {
        const data = await apiJson<{ status: RuntimeStatus; logs?: LogEntry[]; nextSeq?: number }>(
          `/api/projects/${projectId}/runtime?logs=1&since=${sinceRef.current}`,
        );
        if (stopped) return;
        if (revision === controlRevision.current && !pollingDuringStop && !stopInFlight.current) {
          setStatus(data.status);
        }
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
      const stopping = action === "stop";
      if (stopping) {
        // Cancellation must remain available while a long start POST is pending.
        if (stopInFlight.current) return;
        stopInFlight.current = true;
        setStopBusy(true);
      } else {
        if (actionInFlight.current || stopInFlight.current || actionBusy !== null || preparing)
          return;
        actionInFlight.current = true;
        setActionBusy(action);
      }
      const revision = ++controlRevision.current;
      setActionError(null);
      try {
        await apiJson(`/api/projects/${projectId}/runtime?action=${action}`, { method: "POST" });
        if (revision !== controlRevision.current) return;
        // The latest control wins: an old start response cannot overwrite stop.
        const data = await apiJson<{ status: RuntimeStatus; logs?: LogEntry[]; nextSeq?: number }>(
          `/api/projects/${projectId}/runtime?logs=1&since=${sinceRef.current}`,
        );
        if (revision === controlRevision.current) setStatus(data.status);
      } catch (err) {
        if (revision === controlRevision.current) {
          setActionError(err instanceof Error ? err.message : "操作失败");
        }
      } finally {
        if (stopping) {
          stopInFlight.current = false;
          setStopBusy(false);
        } else {
          actionInFlight.current = false;
        }
        if (revision === controlRevision.current) setActionBusy(null);
      }
    },
    [actionBusy, preparing, projectId],
  );

  const errorLines = logs
    .filter((l) => l.stream === "stderr" || /error|failed|exception/i.test(l.text))
    .slice(-30);

  const createFixTask = useCallback(async () => {
    setActionBusy("fix");
    setActionError(null);
    try {
      const message = buildRuntimeFixMessage(errorLines);
      await apiJson(`/api/projects/${projectId}/agent-tasks`, {
        method: "POST",
        body: JSON.stringify({
          message,
          maxSteps: 9,
        }),
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "发起修复任务失败");
    } finally {
      setActionBusy(null);
    }
  }, [errorLines, projectId]);

  // Credentials are requested only by an explicit click, kept only in memory,
  // and automatically hidden after one minute (or when this view unmounts).
  useEffect(() => {
    if (!previewLogin) return;
    const timer = setTimeout(() => setPreviewLogin(null), 60_000);
    return () => clearTimeout(timer);
  }, [previewLogin]);

  const revealPreviewLogin = async () => {
    if (status?.backend?.stack !== "python" || previewLoginInFlight.current) return;
    previewLoginInFlight.current = true;
    setPreviewLoginBusy(true);
    setActionError(null);
    try {
      const credentials = await apiJson<{ username: string; password: string }>(
        `/api/projects/${projectId}/runtime?action=preview-login`,
        { method: "POST" },
      );
      setPreviewLogin({
        projectId,
        username: credentials.username,
        password: credentials.password,
      });
    } catch {
      setActionError("无法获取预览账号，请确认 Python 服务已就绪后重试");
    } finally {
      previewLoginInFlight.current = false;
      setPreviewLoginBusy(false);
    }
  };

  const visiblePreviewLogin = previewLogin?.projectId === projectId ? previewLogin : null;
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
            <Button
              size="sm"
              onClick={() => void control("start")}
              disabled={actionBusy !== null || stopBusy || preparing}
              title="首次启动会准备运行环境，可能需要数分钟；启动中请勿重复点击"
            >
              {starting ? "启动/准备环境中…" : "Run"}
            </Button>
          ) : null}
          {running || starting || stopBusy ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void control("stop")}
              disabled={stopBusy}
            >
              {stopBusy ? "停止中…" : starting ? "取消启动" : "Stop"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void control("restart")}
            disabled={actionBusy !== null || stopBusy || preparing || !status?.port}
          >
            {actionBusy === "restart" ? "重启中…" : "Restart"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void control("build")}
            disabled={actionBusy !== null || stopBusy || preparing}
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

      {starting ? (
        <p role="status" className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          正在准备环境或启动服务，首次可能需要数分钟。请查看下方控制台进度，无需重复点击 Run 或
          Restart。
        </p>
      ) : null}

      {running && !status?.backend ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">
          当前仅前端页面已就绪，未连接平台管理或显式配置的后端。登录、保存等业务功能仍需后端、数据库等服务；前端能打开不代表全栈运行或业务验收通过。
        </div>
      ) : null}
      {status?.backend ? (
        <div className="mt-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900">
          <span
            className={
              (pythonStack ? pythonReady : status.backend.ready)
                ? "text-emerald-600"
                : "text-amber-600"
            }
          >
            {pythonStack
              ? pythonReady
                ? "全栈 Python 已就绪"
                : status.backend.status === "starting"
                  ? "全栈 Python 启动中"
                  : "全栈 Python 未就绪"
              : `${status.backend.healthScope === "services" ? "后端服务" : "后端 HTTP"}：${
                  status.backend.ready
                    ? "已就绪"
                    : status.backend.status === "starting"
                      ? "连接中"
                      : "未就绪"
                }`}
          </span>
          <span className="ml-3 text-zinc-500">
            {status.backend.managed ? "平台管理" : "外部服务"} · {status.backend.target}
          </span>
          <span className="ml-3 text-zinc-500">
            {status.backend.healthScope === "services"
              ? "验证 MySQL、Redis、backend、worker、beat 服务健康；不代表全部业务验收通过"
              : "仅验证 HTTP 健康；不代表数据库和全部业务验收通过"}
          </span>
          {status.backend.services?.length ? (
            <ul aria-label="后端服务状态" className="mt-2 flex flex-wrap gap-2">
              {status.backend.services.map((service) => (
                <li key={service.name}>
                  <Badge tone={statusTone(service.status)}>
                    {service.name}：{STATUS_LABEL[service.status] ?? service.status}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
          {status.backend.stack === "python" ? (
            <div className="mt-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={previewLoginBusy}
                onClick={() => {
                  if (visiblePreviewLogin) setPreviewLogin(null);
                  else void revealPreviewLogin();
                }}
              >
                {previewLoginBusy
                  ? "获取中…"
                  : visiblePreviewLogin
                    ? "隐藏预览账号"
                    : "查看预览账号"}
              </Button>
              {visiblePreviewLogin ? (
                <div className="mt-2 break-all text-zinc-600 dark:text-zinc-300">
                  <p>仅供本地开发预览使用，1 分钟后自动隐藏，请勿分享。</p>
                  <p>用户名：{visiblePreviewLogin.username}</p>
                  <p>密码：{visiblePreviewLogin.password}</p>
                </div>
              ) : null}
            </div>
          ) : null}
          {status.backend.error ? (
            <p className="mt-1 text-red-600">{status.backend.error}</p>
          ) : null}
        </div>
      ) : null}

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
              {starting
                ? "项目启动/构建中，请稍候…首次会准备环境，可能需要数分钟"
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
                disabled={actionBusy !== null || stopBusy || preparing}
                title="首次启动会准备运行环境，可能需要数分钟；启动中请勿重复点击"
              >
                {starting ? "启动/准备环境中…" : "Run"}
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
