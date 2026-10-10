"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { RocketIcon } from "@/components/icons";

/**
 * Phase 11:部署中心(本地 Docker 优先)。
 * AI 生成部署资产 → Build(真实 compose build)→ Deploy(up -d + 端口探测)→
 * Logs/Restart/Stop/Rollback;文档覆盖 VPS 与 Vercel/Railway/Render 指引。
 */

interface DeployStatus {
  status: string;
  currentTag: string | null;
  history: Array<{ tag: string; deployedAt: string; gitCommit: string | null; note: string }>;
  lastError: string | null;
  assetsReady: boolean;
  dockerAvailable: boolean;
  webPort: number;
  apiPort: number;
}

interface DeployLogLine {
  seq: number;
  stream: string;
  text: string;
  at: number;
}

const STATUS_TONE: Record<string, "neutral" | "accent" | "success" | "danger"> = {
  idle: "neutral",
  building: "accent",
  deploying: "accent",
  running: "success",
  stopped: "neutral",
  failed: "danger",
};

const STATUS_LABELS: Record<string, string> = {
  idle: "未部署",
  building: "构建中",
  deploying: "部署中",
  running: "运行中",
  stopped: "已停止",
  failed: "失败",
};

export function DeployView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logs, setLogs] = useState<DeployLogLine[]>([]);
  const logSeqRef = useRef(0);
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const [assetFiles, setAssetFiles] = useState<Array<{ path: string; bytes: number }> | null>(null);

  const statusQuery = useQuery({
    queryKey: ["deploy-status", projectId],
    queryFn: () => apiJson<{ status: DeployStatus }>(`/api/projects/${projectId}/deploy`),
    refetchInterval: 8_000,
  });
  const status = statusQuery.data?.status ?? null;
  const busyOp = status?.status === "building" || status?.status === "deploying";

  // 增量日志轮询(异步回调 setState,规避 effect 内直接 setState)
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const d = await apiJson<{ logs: DeployLogLine[]; nextSeq: number; status: string }>(
          `/api/projects/${projectId}/deploy?resource=logs&since=${logSeqRef.current}`,
        );
        if (stopped) return;
        if (d.logs.length) {
          logSeqRef.current = d.nextSeq;
          setLogs((prev) => [...prev, ...d.logs].slice(-600));
        }
      } catch {
        /* 轮询失败静默 */
      }
    };
    const timer = setInterval(() => void poll(), 2_000);
    void poll();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [projectId]);

  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["deploy-status", projectId] });
  }, [queryClient, projectId]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  const genAssets = () =>
    run("gen", async () => {
      const d = await apiJson<{ files: Array<{ path: string; bytes: number }> }>(
        `/api/projects/${projectId}/deploy`,
        {
          method: "POST",
          body: JSON.stringify({ action: "generate-assets" }),
        },
      );
      setAssetFiles(d.files);
      setNotice(`部署资产已生成(${d.files.length} 个文件,含 Docker 全套与部署文档)`);
    });

  const build = () =>
    run("build", async () => {
      await apiJson(`/api/projects/${projectId}/deploy`, {
        method: "POST",
        body: JSON.stringify({ action: "build" }),
      });
      setNotice("镜像构建完成");
    });

  const deploy = () =>
    run("deploy", async () => {
      await apiJson(`/api/projects/${projectId}/deploy`, {
        method: "POST",
        body: JSON.stringify({ action: "deploy" }),
      });
      setNotice("部署完成,服务已启动");
    });

  const restart = () =>
    run("restart", async () => {
      await apiJson(`/api/projects/${projectId}/deploy`, {
        method: "POST",
        body: JSON.stringify({ action: "restart" }),
      });
      setNotice("已重启");
    });

  const stop = () =>
    run("stop", async () => {
      await apiJson(`/api/projects/${projectId}/deploy`, {
        method: "POST",
        body: JSON.stringify({ action: "stop" }),
      });
      setNotice("已停止(数据卷保留)");
    });

  const rollback = (tag: string) =>
    run(`rollback-${tag}`, async () => {
      await apiJson(`/api/projects/${projectId}/deploy`, {
        method: "POST",
        body: JSON.stringify({ action: "rollback", tag }),
      });
      setNotice(`已回滚到镜像 ${tag}`);
    });

  const fetchLogs = () =>
    run("fetch-logs", async () => {
      await apiJson(`/api/projects/${projectId}/deploy`, {
        method: "POST",
        body: JSON.stringify({ action: "fetch-logs" }),
      });
    });

  if (statusQuery.isPending) return <Skeleton className="h-96" />;

  return (
    <div className="space-y-5">
      {/* 状态 + 操作 */}
      <section className="rounded-md border border-zinc-200 bg-white px-4 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={STATUS_TONE[status?.status ?? "idle"] ?? "neutral"}>
            {STATUS_LABELS[status?.status ?? "idle"] ?? status?.status}
          </Badge>
          {status?.currentTag ? (
            <span className="font-mono text-[11px] text-zinc-500">
              镜像 tag:{status.currentTag}
            </span>
          ) : null}
          <span className="text-[11px] text-zinc-400">
            {status?.assetsReady ? "部署资产已生成" : "部署资产未生成"} · Docker:
            {status?.dockerAvailable ? "可用" : "不可用"}
          </span>
          {status?.status === "running" ? (
            <a
              href={`http://localhost:${status.webPort}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-violet-600 hover:underline dark:text-violet-400"
            >
              打开部署站点 ↗(http://localhost:{status.webPort})
            </a>
          ) : null}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null || busyOp}
              onClick={() => void genAssets()}
            >
              {busy === "gen"
                ? "AI 生成中…"
                : status?.assetsReady
                  ? "重新生成部署资产"
                  : "AI 生成部署资产"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy !== null || busyOp || !status?.assetsReady || !status?.dockerAvailable}
              onClick={() => void build()}
            >
              {busy === "build" || status?.status === "building" ? "构建中…" : "Build"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy !== null || busyOp || !status?.assetsReady || !status?.dockerAvailable}
              onClick={() => void deploy()}
            >
              {busy === "deploy" || status?.status === "deploying" ? "部署中…" : "Deploy"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null || status?.status !== "running"}
              onClick={() => void restart()}
            >
              Restart
            </Button>
            <ConfirmButton
              onConfirm={() => void stop()}
              confirmLabel="确认停止并移除容器?"
              variant="secondary"
              size="sm"
              disabled={
                busy !== null || (status?.status !== "running" && status?.status !== "failed")
              }
            >
              Stop
            </ConfirmButton>
          </div>
        </div>
        {status?.lastError ? (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-400">
            {status.lastError}
          </p>
        ) : null}
      </section>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          {notice}
        </p>
      ) : null}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* 日志 */}
        <section className="flex h-[30rem] flex-col overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60">
          <header className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              部署日志
            </h2>
            <span className="text-[11px] text-zinc-400">真实 docker 命令输出</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={busy !== null}
              onClick={() => void fetchLogs()}
            >
              {busy === "fetch-logs" ? "拉取中…" : "拉取容器日志"}
            </Button>
          </header>
          <div
            ref={logBoxRef}
            className="min-h-0 flex-1 overflow-y-auto bg-zinc-50 p-3 font-mono text-[11px] leading-5 dark:bg-zinc-950/60"
          >
            {logs.length === 0 ? (
              <p className="py-8 text-center text-zinc-400">
                暂无日志。Build / Deploy 的 docker 输出会实时显示在这里。
              </p>
            ) : (
              logs.map((line) => (
                <div
                  key={line.seq}
                  className={
                    line.stream === "err"
                      ? "text-red-600 dark:text-red-400"
                      : line.stream === "system"
                        ? "text-violet-600 dark:text-violet-400"
                        : "text-zinc-600 dark:text-zinc-400"
                  }
                >
                  {line.text}
                </div>
              ))
            )}
          </div>
        </section>

        <div className="space-y-4">
          {/* 部署历史 / 回滚 */}
          <section className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
            <p className="mb-2 px-1 text-xs font-semibold text-zinc-500">部署历史(Rollback)</p>
            {!status?.history.length ? (
              <p className="px-1 py-2 text-xs text-zinc-400">还没有部署记录</p>
            ) : (
              <div className="space-y-1">
                {status.history.map((h, i) => (
                  <div
                    key={`${h.tag}-${i}`}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  >
                    <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {h.tag === "latest" ? "latest" : `#${h.tag.slice(-6)}`}
                    </code>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500">
                      {new Date(h.deployedAt).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {h.gitCommit ? ` · ${h.gitCommit}` : ""} · {h.note}
                    </span>
                    {status.currentTag === h.tag ? (
                      <Badge tone="success">当前</Badge>
                    ) : (
                      <button
                        type="button"
                        disabled={busy !== null || busyOp || !status?.dockerAvailable}
                        onClick={() => void rollback(h.tag)}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-violet-600 hover:bg-violet-50 disabled:opacity-50 dark:text-violet-400 dark:hover:bg-violet-500/10"
                      >
                        {busy === `rollback-${h.tag}`
                          ? "…"
                          : h.note.includes("未部署")
                            ? "部署此版"
                            : "切换到此版"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 px-1 text-[10px] leading-relaxed text-zinc-400">
              Rollback 通过切换镜像 TAG 重建容器实现,数据卷保留;回滚前请确认已停止编辑中的数据写入。
            </p>
          </section>

          {/* 资产清单 */}
          <section className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
            <p className="mb-2 px-1 text-xs font-semibold text-zinc-500">部署资产</p>
            {assetFiles ? (
              <ul className="space-y-0.5 px-1">
                {assetFiles.map((f) => (
                  <li
                    key={f.path}
                    className="flex items-center gap-2 font-mono text-[11px] text-zinc-600 dark:text-zinc-400"
                  >
                    <RocketIcon className="h-3 w-3 text-violet-400" />
                    <span className="min-w-0 flex-1 truncate">{f.path}</span>
                    <span className="text-zinc-400">{(f.bytes / 1024).toFixed(1)}K</span>
                  </li>
                ))}
              </ul>
            ) : status?.assetsReady ? (
              <p className="px-1 text-[11px] text-zinc-500">
                资产已存在于工作区:docker-compose.yml 与 deploy/ 目录(Dockerfile.web /
                Dockerfile.api / nginx.conf / .env.example / deploy.sh /
                DEPLOY-README.md),可在开发工作区查看与修改。
              </p>
            ) : (
              <p className="px-1 text-[11px] text-zinc-400">
                尚未生成。AI 会依据项目真实技术栈/数据库/配置文件生成 Docker 全套。
              </p>
            )}
          </section>

          {/* 平台支持说明 */}
          <section className="rounded-md border border-zinc-200 bg-white p-3 text-[11px] leading-relaxed text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60">
            <p className="mb-1 text-xs font-semibold text-zinc-600 dark:text-zinc-300">
              平台支持
            </p>
            <p>
              本阶段优先真实支持 <strong>本地 Docker</strong> 与 <strong>自有 VPS</strong>(deploy.sh
              可直接 scp 使用); Vercel / Railway / Render
              的适配要点(环境变量、构建命令、数据库替代)已写入
              <code className="mx-1 rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                deploy/DEPLOY-README.md
              </code>
              ,按指引即可完成云端部署,不做云平台 API 集成。
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
