"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import {
  TEST_KINDS,
  TEST_KIND_LABELS,
  type TestKind,
  type TestRunDto,
  type TestResultDto,
} from "@/lib/testing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SparklesIcon } from "@/components/icons";

type Action = "generate" | "run" | "analyze" | "fix";

function ProgressBar({ passed, failed, total }: { passed: number; failed: number; total: number }) {
  const safeTotal = Math.max(total, 1);
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
      <div className="bg-emerald-500" style={{ width: `${(passed / safeTotal) * 100}%` }} />
      <div className="bg-red-400" style={{ width: `${(failed / safeTotal) * 100}%` }} />
    </div>
  );
}

function ResultLine({
  result,
  onFix,
  onIgnore,
  fixing,
}: {
  result: TestResultDto;
  onFix: (result: TestResultDto) => void;
  onIgnore: (result: TestResultDto) => void;
  fixing: boolean;
}) {
  const [open, setOpen] = useState(false);
  const analysis = result.analysis;
  return (
    <li className="border-b border-zinc-100 py-2 last:border-b-0 dark:border-zinc-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 text-left text-xs"
      >
        <span
          className={
            result.status === "passed"
              ? "text-emerald-500"
              : result.status === "skipped"
                ? "text-zinc-400"
                : "text-red-500"
          }
        >
          {result.status === "passed" ? "✓" : result.status === "skipped" ? "○" : "✕"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-zinc-800 dark:text-zinc-200">
            {result.name}
          </span>
          {result.status === "failed" && !result.ignored ? (
            <span className="mt-0.5 block truncate text-red-500/80">
              {result.message.split("\n")[0]?.slice(0, 120)}
            </span>
          ) : null}
        </span>
        {result.ignored ? <Badge>已忽略</Badge> : null}
        <span className="shrink-0 text-zinc-300 dark:text-zinc-600">
          {open ? "收起" : "详情"}
        </span>
      </button>

      {open ? (
        <div className="mt-2 space-y-2 pl-5">
          {result.message ? (
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-zinc-50 px-2.5 py-1.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
              {result.message}
            </pre>
          ) : null}
          {analysis ? (
            <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2 text-[11px] leading-relaxed text-zinc-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-zinc-300">
              <p className="font-semibold text-violet-700 dark:text-violet-300">AI 失败分析</p>
              <p className="mt-1">
                <b>错误:</b>
                {analysis.error}
              </p>
              {analysis.stackTrace ? (
                <p>
                  <b>堆栈:</b>
                  {analysis.stackTrace}
                </p>
              ) : null}
              <p>
                <b>相关文件:</b>
                <span className="font-mono">{analysis.relatedFile || "(未知)"}</span>
              </p>
              {analysis.relatedRequirement ? (
                <p>
                  <b>关联需求:</b>
                  {analysis.relatedRequirement}
                </p>
              ) : null}
              <p>
                <b>可能原因:</b>
                {analysis.possibleCause}
              </p>
              <p>
                <b>建议修复:</b>
                {analysis.suggestedFix}
              </p>
            </div>
          ) : null}
          {result.status === "failed" && !result.ignored ? (
            <div className="flex gap-2">
              <Button size="sm" onClick={() => onFix(result)} disabled={fixing}>
                <SparklesIcon className="h-3.5 w-3.5" />
                {fixing ? "修复中…" : "AI 修复"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onIgnore(result)}
                disabled={fixing}
              >
                忽略
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function RunCard({
  projectId,
  run,
  onChanged,
  onIgnore,
}: {
  projectId: string;
  run: TestRunDto;
  onChanged: () => void;
  onIgnore: (result: TestResultDto) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const failedResults = run.results.filter((r) => r.status === "failed" && !r.ignored);

  async function doAction(action: Action, extra?: Record<string, unknown>) {
    setBusy(action + (extra?.resultId ?? ""));
    try {
      await apiJson(`/api/projects/${projectId}/tests?action=${action}`, {
        method: "POST",
        body: JSON.stringify({ runId: run.id, ...extra }),
      });
      onChanged();
    } catch {
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {TEST_KIND_LABELS[run.kind]} ·{" "}
            <span
              className={run.failed > 0 ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"}
            >
              {run.passed} / {run.total} Passed
            </span>
            {run.failed > 0 ? <span className="text-red-500">{run.failed} Failed</span> : null}
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-400">
            {new Date(run.createdAt).toLocaleString("zh-CN")} · {(run.durationMs / 1000).toFixed(1)}
            s · {run.command}
          </p>
        </div>
        <Badge tone={run.status === "passed" ? "success" : "danger"}>
          {run.status === "passed" ? "全部通过" : "存在失败"}
        </Badge>
      </div>

      <div className="mt-3">
        <ProgressBar passed={run.passed} failed={run.failed} total={run.total} />
      </div>

      <ul className="mt-3">
        {run.results.map((r) => (
          <ResultLine
            key={r.id}
            result={r}
            fixing={busy !== null}
            onFix={(result) => void doAction("fix", { resultId: result.id })}
            onIgnore={(result) => onIgnore(result)}
          />
        ))}
      </ul>

      {failedResults.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void doAction("analyze")} disabled={busy !== null}>
            <SparklesIcon className="h-3.5 w-3.5" />
            {busy === "analyze" ? "分析中…" : "AI 分析失败"}
          </Button>
          <Button size="sm" onClick={() => void doAction("fix")} disabled={busy !== null}>
            <SparklesIcon className="h-3.5 w-3.5" />
            {busy === "fix" ? "修复中…(修复后自动回归)" : "Fix All"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void doAction("run")}
            disabled={busy !== null}
          >
            重试(Retry)
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function TestingCenterView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<TestKind>("unit");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ["test-runs", projectId],
    queryFn: () => apiJson<{ runs: TestRunDto[] }>(`/api/projects/${projectId}/tests`),
    refetchInterval: (query) =>
      (query.state.data?.runs ?? []).some((r) => r.status === "running") ? 2500 : 15000,
  });

  async function doAction(action: Action, extra?: Record<string, unknown>) {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const data = await apiJson<{
        notes?: string;
        files?: string[];
        run?: TestRunDto;
        fixed?: number;
        newRunId?: string | null;
      }>(`/api/projects/${projectId}/tests?action=${action}`, {
        method: "POST",
        body: JSON.stringify({ kind, ...extra }),
      });
      if (action === "generate") {
        setNotice(
          `已生成 ${data.files?.length ?? 0} 个测试文件:${(data.files ?? []).join("、")}(vitest 已就绪)`,
        );
      }
      if (action === "fix" && data.fixed === 0) {
        setNotice("没有可自动修复的失败用例(可能已忽略或已修复)");
      }
      await queryClient.invalidateQueries({ queryKey: ["test-runs", projectId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  async function ignoreResult(run: TestRunDto, result: TestResultDto) {
    setBusy("ignore-" + result.id);
    try {
      await apiJson(`/api/projects/${projectId}/tests?action=ignore`, {
        method: "POST",
        body: JSON.stringify({ runId: run.id, resultId: result.id }),
      });
      await queryClient.invalidateQueries({ queryKey: ["test-runs", projectId] });
    } finally {
      setBusy(null);
    }
  }

  const runs = runsQuery.data?.runs ?? [];
  const latest = runs[0];

  return (
    <div className="mx-auto max-w-4xl">
      {/* 操作区 */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          AI 测试中心
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          根据需求分析 + 系统架构 + 现有代码生成 Vitest 测试(单元 / API / E2E / 权限),
          真实执行;失败用例支持 AI 分析、修复与回归重跑。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {TEST_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                kind === k
                  ? "border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300"
                  : "border-zinc-200 text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-300"
              }`}
            >
              {TEST_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void doAction("generate")} disabled={busy !== null}>
            <SparklesIcon className="h-3.5 w-3.5" />
            {busy === "generate" ? "AI 生成测试中…(1-2 分钟)" : "AI 生成测试"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void doAction("run")}
            disabled={busy !== null}
          >
            {busy === "run" ? "执行中…" : "运行测试"}
          </Button>
        </div>
        {notice ? (
          <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </div>

      {/* 最新运行 */}
      {runsQuery.isPending ? (
        <Skeleton className="mt-6 h-48 rounded-lg" />
      ) : latest ? (
        <div className="mt-6">
          <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            最近一次运行
          </h3>
          <RunCard
            projectId={projectId}
            run={latest}
            onChanged={() =>
              void queryClient.invalidateQueries({ queryKey: ["test-runs", projectId] })
            }
            onIgnore={(result) => void ignoreResult(latest, result)}
          />
        </div>
      ) : null}

      {/* 历史 */}
      {runs.length > 1 ? (
        <div className="mt-6">
          <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            历史运行
          </h3>
          <div className="space-y-2">
            {runs.slice(1).map((run) => (
              <div
                key={run.id}
                className="flex items-center gap-3 rounded-md border border-zinc-200 px-4 py-2.5 text-xs dark:border-zinc-800"
              >
                <Badge tone={run.status === "passed" ? "success" : "danger"}>
                  {run.passed}/{run.total}
                </Badge>
                <span className="text-zinc-600 dark:text-zinc-300">
                  {TEST_KIND_LABELS[run.kind]}
                </span>
                <span className="text-zinc-400">
                  {new Date(run.createdAt).toLocaleString("zh-CN")}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
