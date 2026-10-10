"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Skeleton } from "@/components/ui/skeleton";
import { GitBranchIcon, HistoryIcon, RefreshIcon } from "@/components/icons";
import type { DiffFile } from "@/server/git";

/**
 * Phase 8:版本控制视图。
 * 顶栏:分支信息 + 新建分支 + 刷新;左:工作区变更 + 提交;右:提交历史 + Diff + 回滚/恢复文件。
 */

interface GitStatusDto {
  initialized: boolean;
  branch: string;
  branches: Array<{ name: string; current: boolean }>;
  hasCommits: boolean;
  changes: Array<{ path: string; status: string }>;
}

interface CommitDto {
  hash: string;
  shortHash: string;
  message: string;
  body: string;
  author: string;
  date: string;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
}

const STATUS_LABELS: Record<
  string,
  { label: string; tone: "neutral" | "accent" | "success" | "danger" }
> = {
  added: { label: "新增", tone: "success" },
  untracked: { label: "未跟踪", tone: "neutral" },
  modified: { label: "修改", tone: "accent" },
  deleted: { label: "删除", tone: "danger" },
  renamed: { label: "重命名", tone: "accent" },
  conflicted: { label: "冲突", tone: "danger" },
};

const CHANGE_KIND_LABELS: Record<string, string> = {
  feat: "功能",
  fix: "修复",
  refactor: "重构",
  docs: "文档",
  test: "测试",
  chore: "杂务",
  style: "样式",
  perf: "性能",
};

function renderPatchLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++"))
    return "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300";
  if (line.startsWith("-") && !line.startsWith("---"))
    return "bg-red-500/10 text-red-800 dark:text-red-300";
  if (line.startsWith("@@")) return "text-violet-600 dark:text-violet-400";
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "text-zinc-400";
  }
  return "text-zinc-600 dark:text-zinc-400";
}

function DiffPanel({ files, emptyHint }: { files: DiffFile[] | null; emptyHint: string }) {
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const current = useMemo(() => {
    if (!files || files.length === 0) return null;
    return files.find((f) => f.path === activeFile) ?? files[0];
  }, [files, activeFile]);

  if (!files) return <p className="px-3 py-6 text-center text-xs text-zinc-400">加载中…</p>;
  if (files.length === 0)
    return <p className="px-3 py-6 text-center text-xs text-zinc-400">{emptyHint}</p>;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-52 shrink-0 overflow-y-auto border-r border-zinc-200 py-1 dark:border-zinc-800">
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            onClick={() => setActiveFile(file.path)}
            title={file.path}
            className={`block w-full px-2.5 py-1.5 text-left font-mono text-[11px] transition-colors ${
              current?.path === file.path
                ? "bg-violet-600/10 text-violet-700 dark:text-violet-300"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/70"
            }`}
          >
            <span className="block truncate">{file.path.split("/").pop()}</span>
            <span className="block truncate text-[10px] text-zinc-400">
              <span className="text-emerald-600">+{file.additions}</span>{" "}
              <span className="text-red-500">-{file.deletions}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-auto">
        {current ? (
          <>
            <p className="border-b border-zinc-200 px-3 py-1.5 font-mono text-[11px] text-zinc-500 dark:border-zinc-800">
              {current.oldPath ? `${current.oldPath} → ${current.path}` : current.path}
            </p>
            <pre className="min-w-max p-0 font-mono text-[11px] leading-5">
              {current.patch
                ? current.patch.split("\n").map((line, i) => (
                    <div key={i} className={`px-3 ${renderPatchLineClass(line)}`}>
                      {line || " "}
                    </div>
                  ))
                : "(无补丁内容)"}
            </pre>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function GitView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitBody, setCommitBody] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [diffTarget, setDiffTarget] = useState<string>("WORKING");

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["git-status", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["git-commits", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["git-diff", projectId] });
  }, [queryClient, projectId]);

  const statusQuery = useQuery({
    queryKey: ["git-status", projectId],
    queryFn: () =>
      apiJson<{ status: GitStatusDto }>(`/api/projects/${projectId}/git?resource=status`),
    refetchInterval: 15_000,
  });
  const commitsQuery = useQuery({
    queryKey: ["git-commits", projectId],
    queryFn: () =>
      apiJson<{ commits: CommitDto[] }>(`/api/projects/${projectId}/git?resource=commits`),
    refetchInterval: 15_000,
  });
  const diffQuery = useQuery({
    queryKey: ["git-diff", projectId, diffTarget],
    queryFn: () =>
      apiJson<{ files: DiffFile[] }>(
        `/api/projects/${projectId}/git?resource=diff&hash=${encodeURIComponent(diffTarget)}`,
      ),
  });

  const status = statusQuery.data?.status ?? null;
  const commits = commitsQuery.data?.commits ?? [];
  const changes = status?.changes ?? [];

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  const doAiMessage = () =>
    run("ai-message", async () => {
      const data = await apiJson<{ message: string; body: string }>(
        `/api/projects/${projectId}/git?action=ai-message`,
        { method: "POST", body: JSON.stringify({ action: "ai-message" }) },
      );
      setCommitMessage(data.message);
      setCommitBody(data.body);
    });

  const doCommit = () =>
    run("commit", async () => {
      const full = commitBody.trim()
        ? `${commitMessage.trim()}\n\n${commitBody.trim()}`
        : commitMessage.trim();
      await apiJson(`/api/projects/${projectId}/git?action=commit`, {
        method: "POST",
        body: JSON.stringify({ action: "commit", message: full }),
      });
      setCommitMessage("");
      setCommitBody("");
      setDiffTarget("WORKING");
    });

  const doBranch = () =>
    run("branch", async () => {
      await apiJson(`/api/projects/${projectId}/git?action=branch`, {
        method: "POST",
        body: JSON.stringify({ action: "branch", name: newBranchName.trim() }),
      });
      setNewBranchName("");
    });

  const doCheckout = (name: string) =>
    run(`checkout-${name}`, async () => {
      await apiJson(`/api/projects/${projectId}/git?action=checkout`, {
        method: "POST",
        body: JSON.stringify({ action: "checkout", name }),
      });
    });

  const doRollback = (hash: string) =>
    run(`rollback-${hash}`, async () => {
      await apiJson(`/api/projects/${projectId}/git?action=rollback`, {
        method: "POST",
        body: JSON.stringify({ action: "rollback", hash }),
      });
      setDiffTarget("WORKING");
    });

  const doRestoreFile = (hash: string, path: string) =>
    run(`restore-${hash}-${path}`, async () => {
      await apiJson(`/api/projects/${projectId}/git?action=restore-file`, {
        method: "POST",
        body: JSON.stringify({ action: "restore-file", hash, path }),
      });
    });

  if (statusQuery.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  if (!status?.initialized) {
    return <p className="text-sm text-zinc-500">仓库初始化失败,请刷新页面重试。</p>;
  }

  return (
    <div className="space-y-6">
      {/* 顶栏:分支 + 新建分支 + 刷新 */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-md border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/60">
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-2.5 py-1 font-mono text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          <GitBranchIcon className="h-3.5 w-3.5" />
          {status.branch}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {status.branches.map((b) => (
            <button
              key={b.name}
              type="button"
              disabled={b.current || busy !== null}
              onClick={() => void doCheckout(b.name)}
              className={`rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors ${
                b.current
                  ? "bg-violet-600/10 text-violet-700 dark:text-violet-300"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-50 dark:hover:bg-zinc-800"
              }`}
              title={b.current ? "当前分支" : `切换到 ${b.name}`}
            >
              {b.name}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={newBranchName}
            onChange={(event) => setNewBranchName(event.target.value)}
            placeholder="新分支名,如 feature/login"
            className="w-52 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!newBranchName.trim() || busy !== null}
            onClick={() => void doBranch()}
          >
            {busy === "branch" ? "创建中…" : "新建分支"}
          </Button>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={busy !== null}>
            <RefreshIcon className="h-3.5 w-3.5" />
            刷新
          </Button>
        </div>
      </div>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-2">
        {/* 左:工作区变更 + 提交 */}
        <section className="overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60">
          <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              工作区变更
              <span className="ml-2 text-xs font-normal text-zinc-400">
                {changes.length} 个文件
              </span>
            </h2>
            <Button
              variant="secondary"
              size="sm"
              disabled={changes.length === 0 || busy !== null}
              onClick={() => void doAiMessage()}
            >
              {busy === "ai-message" ? "AI 生成中…" : "AI 生成提交信息"}
            </Button>
          </header>

          <div className="max-h-64 overflow-y-auto p-2">
            {changes.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-zinc-400">
                工作区干净,没有待提交的变更
              </p>
            ) : (
              changes.map((change) => {
                const meta = STATUS_LABELS[change.status] ?? STATUS_LABELS.modified;
                return (
                  <div
                    key={change.path}
                    className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  >
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-600 dark:text-zinc-400"
                      title={change.path}
                    >
                      {change.path}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-2 flex items-center gap-2">
              <input
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="提交标题,如 feat: implement user authentication"
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500"
              />
              {commitMessage.trim() ? (
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">
                  {CHANGE_KIND_LABELS[commitMessage.split(/[:\s]/)[0]] ?? "自定义"}
                </span>
              ) : null}
            </div>
            <textarea
              value={commitBody}
              onChange={(event) => setCommitBody(event.target.value)}
              placeholder="提交正文(可选):修改了什么、为什么"
              rows={2}
              className="mb-2 w-full resize-y rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500"
            />
            <Button
              variant="primary"
              size="sm"
              className="w-full"
              disabled={commitMessage.trim().length < 2 || changes.length === 0 || busy !== null}
              onClick={() => void doCommit()}
            >
              {busy === "commit" ? "提交中…" : `提交 ${changes.length} 个变更`}
            </Button>
          </div>
        </section>

        {/* 右:提交历史 */}
        <section className="overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60">
          <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
            <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              <HistoryIcon className="h-4 w-4" />
              提交历史
              <span className="text-xs font-normal text-zinc-400">{commits.length} 个版本</span>
            </h2>
            {!status.hasCommits ? <Badge tone="neutral">暂无提交</Badge> : null}
          </header>
          <div className="max-h-[26rem] overflow-y-auto p-2">
            {commits.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-zinc-400">
                还没有提交。完成一次变更提交或让 Agent 跑一个任务后,这里会出现版本历史。
              </p>
            ) : (
              commits.map((commit) => (
                <div
                  key={commit.hash}
                  className="rounded-lg px-2.5 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {commit.shortHash}
                    </code>
                    <span
                      className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-800 dark:text-zinc-200"
                      title={commit.message}
                    >
                      {commit.message.split("\n")[0]}
                    </span>
                    <span className="shrink-0 text-[10px] text-zinc-400">
                      {commit.date
                        ? new Date(commit.date).toLocaleString("zh-CN", {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : ""}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedCommit(expandedCommit === commit.hash ? null : commit.hash)
                      }
                      className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800"
                    >
                      {expandedCommit === commit.hash
                        ? "收起文件"
                        : `${commit.files.length} 个文件`}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDiffTarget(commit.hash)}
                      className="rounded px-1.5 py-0.5 text-[11px] text-violet-600 transition-colors hover:bg-violet-50 dark:text-violet-400 dark:hover:bg-violet-500/10"
                    >
                      查看 Diff
                    </button>
                    <ConfirmButton
                      onConfirm={() => void doRollback(commit.hash)}
                      confirmLabel={`确认回滚到 ${commit.shortHash}?`}
                      variant="ghost"
                      size="sm"
                      className="!px-1.5 text-[11px] text-red-600 dark:text-red-400"
                      disabled={busy !== null}
                    >
                      恢复此版本
                    </ConfirmButton>
                    {commit.message.includes(`Task: `) ? (
                      <Badge tone="accent">Agent 任务</Badge>
                    ) : null}
                  </div>
                  {expandedCommit === commit.hash ? (
                    <div className="mt-1.5 space-y-0.5 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                      {commit.files.map((file) => (
                        <div key={file.path} className="flex items-center gap-2 text-[11px]">
                          <span className="text-emerald-600">+{file.additions}</span>
                          <span className="text-red-500">-{file.deletions}</span>
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-zinc-500"
                            title={file.path}
                          >
                            {file.path}
                          </span>
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void doRestoreFile(commit.hash, file.path)}
                            className="shrink-0 rounded px-1.5 py-0.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-50 dark:hover:bg-zinc-800"
                            title={`把 ${file.path} 恢复到 ${commit.shortHash} 版本`}
                          >
                            恢复此文件
                          </button>
                        </div>
                      ))}
                      {commit.body ? (
                        <pre className="mt-2 whitespace-pre-wrap border-t border-zinc-200 pt-2 text-[11px] text-zinc-500 dark:border-zinc-800">
                          {commit.body}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Diff 查看器 */}
      <section className="flex h-96 flex-col overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60">
        <header className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Diff 查看器
          </h2>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setDiffTarget("WORKING")}
              className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                diffTarget === "WORKING"
                  ? "bg-violet-600/10 text-violet-700 dark:text-violet-300"
                  : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              工作区 vs HEAD
            </button>
            {diffTarget !== "WORKING" ? (
              <span className="rounded-md bg-violet-600/10 px-2 py-0.5 font-mono text-[11px] text-violet-700 dark:text-violet-300">
                {commits.find((c) => c.hash === diffTarget)?.shortHash ?? diffTarget.slice(0, 7)}
              </span>
            ) : null}
          </div>
          {diffTarget !== "WORKING" ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setDiffTarget("WORKING")}
            >
              返回工作区
            </Button>
          ) : null}
        </header>
        {diffQuery.isPending ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-400">加载中…</p>
        ) : (
          <DiffPanel
            files={diffQuery.data?.files ?? null}
            emptyHint={
              diffTarget === "WORKING" ? "工作区与最新提交没有差异" : "该提交没有可显示的差异"
            }
          />
        )}
      </section>

      <p className="text-[11px] leading-relaxed text-zinc-400">
        回滚说明:「恢复此版本」会先自动创建备份分支(backup/pre-rollback-时间戳)保存当前进度,再把项目重置到所选版本;备份分支显示在顶栏,可随时切回。Agent
        每次完成任务后会自动生成一次提交(带 Agent 任务标记)。
      </p>
    </div>
  );
}
