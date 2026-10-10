"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import {
  ARCHITECTURE_STATUS_LABELS,
  MODULE_LAYER_LABELS,
  TECH_LAYER_LABELS,
  type ArchitectureDto,
  type ModuleLayer,
  type TechLayer,
} from "@/lib/architecture";
import { PageHeader } from "@/components/layout/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Skeleton } from "@/components/ui/skeleton";
import { SparklesIcon, ChevronRightIcon } from "@/components/icons";

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  POST: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  PUT: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  DELETE: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  PATCH: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
};

function ElapsedSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular-nums">({seconds} 秒)</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function ArchitectureView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [regeneratingDb, setRegeneratingDb] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isPending, refetch } = useQuery({
    queryKey: ["architecture", projectId],
    queryFn: () =>
      apiJson<{ architecture: ArchitectureDto | null }>(`/api/projects/${projectId}/architecture`),
  });

  function apply(payload: { architecture: ArchitectureDto | null }) {
    queryClient.setQueryData(["architecture", projectId], payload);
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
  }

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      apply(
        await apiJson<{ architecture: ArchitectureDto | null }>(
          `/api/projects/${projectId}/architecture/generate`,
          { method: "POST" },
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败,请重试");
    } finally {
      setGenerating(false);
    }
  }

  async function statusAction(action: "confirm" | "unconfirm" | "discard") {
    setError(null);
    try {
      await apiJson(`/api/projects/${projectId}/architecture/status`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      await refetch();
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    }
  }

  async function regenerateDatabase() {
    setRegeneratingDb(true);
    setError(null);
    try {
      apply(
        await apiJson<{ architecture: ArchitectureDto | null }>(
          `/api/projects/${projectId}/architecture/regenerate-database`,
          { method: "POST" },
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新生成失败");
    } finally {
      setRegeneratingDb(false);
    }
  }

  if (isPending) {
    return (
      <div aria-busy className="space-y-4">
        <Skeleton className="h-28 rounded-lg" />
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  const architecture = data?.architecture ?? null;

  // 生成中 / 未生成
  if (generating || !architecture) {
    return (
      <div>
        <PageHeader title="系统架构" description="AI 将根据项目与需求分析生成可执行的软件架构" />
        {generating ? (
          <div className="mt-8 rounded-2xl border border-zinc-200 p-12 text-center dark:border-zinc-800">
            <span className="mx-auto flex h-11 w-11 animate-pulse items-center justify-center rounded-md bg-violet-600/10 text-violet-600 dark:text-violet-400">
              <SparklesIcon />
            </span>
            <p className="mt-4 font-medium text-zinc-900 dark:text-zinc-100">
              AI 正在设计系统架构 <ElapsedSeconds />
            </p>
            <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
              生成技术选型、前后端架构、API 规划、权限设计与数据库 ER,通常需要 1-3 分钟。
            </p>
          </div>
        ) : (
          <div className="mt-8">
            {error ? (
              <div className="mb-4 rounded-md border border-red-200 bg-red-50/60 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/5 dark:text-red-400">
                {error}
              </div>
            ) : null}
            <div className="rounded-2xl border border-dashed border-zinc-300 p-12 text-center dark:border-zinc-700">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-md bg-violet-600/10 text-violet-600 dark:text-violet-400">
                <SparklesIcon />
              </span>
              <p className="mt-4 font-medium text-zinc-900 dark:text-zinc-100">
                让 AI 设计系统架构
              </p>
              <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                基于当前项目与需求分析,生成技术选型、前后端架构、API 模块、权限设计与数据库 ER,
                全部结构化保存;确认后不会被自动覆盖。
              </p>
              <Button size="md" className="mt-5" onClick={() => void generate()}>
                <SparklesIcon className="h-4 w-4" />
                AI 生成系统架构
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const confirmed = architecture.status === "confirmed";
  const db = architecture.database;

  return (
    <div>
      <PageHeader
        title="系统架构"
        description={`${architecture.summary.slice(0, 60)}…`}
        actions={
          <div className="flex items-center gap-2">
            {confirmed ? (
              <>
                <Badge tone="success">{ARCHITECTURE_STATUS_LABELS.confirmed}</Badge>
                <ConfirmButton
                  variant="secondary"
                  size="md"
                  confirmLabel="撤销确认?"
                  onConfirm={() => void statusAction("unconfirm")}
                >
                  撤销确认
                </ConfirmButton>
              </>
            ) : (
              <>
                <Badge tone="accent">{ARCHITECTURE_STATUS_LABELS.draft}</Badge>
                <Button size="md" onClick={() => void statusAction("confirm")}>
                  确认架构
                </Button>
                <ConfirmButton
                  variant="secondary"
                  size="md"
                  confirmLabel="覆盖当前草稿?"
                  onConfirm={() => void generate()}
                >
                  重新生成
                </ConfirmButton>
                <ConfirmButton
                  variant="ghost"
                  size="md"
                  confirmLabel="丢弃草稿?"
                  onConfirm={() => void statusAction("discard")}
                >
                  拒绝
                </ConfirmButton>
              </>
            )}
          </div>
        }
      />

      {!confirmed ? (
        <div className="mt-4 rounded-md border border-violet-200 bg-violet-50/70 px-4 py-2.5 text-xs text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300">
          这是 AI 生成的架构建议草稿。请审阅以下内容,确认后它不会被自动修改;重新分析需先撤销确认。
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50/60 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/5 dark:text-red-400">
          {error}
        </div>
      ) : null}

      <div className="mt-6 space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="总览">
            <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
              {architecture.summary}
            </p>
          </Section>
          <Section title="技术选型理由">
            <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
              {architecture.rationale}
            </p>
          </Section>
          <Section title="前端架构">
            <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
              {architecture.frontendArch}
            </p>
          </Section>
          <Section title="后端架构">
            <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
              {architecture.backendArch}
            </p>
          </Section>
        </div>

        <Section title="技术栈">
          <div className="grid gap-2 sm:grid-cols-2">
            {architecture.techStack.map((item, index) => (
              <div
                key={`${item.layer}-${item.name}-${index}`}
                className="flex items-start gap-2.5 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-700"
              >
                <Badge>{TECH_LAYER_LABELS[item.layer as TechLayer] ?? item.layer}</Badge>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {item.name}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {item.reason}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="系统模块">
          <div className="flex flex-wrap gap-2">
            {architecture.modules.map((module, index) => (
              <div
                key={`${module.name}-${index}`}
                className="flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-700"
                title={module.description}
              >
                <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {module.name}
                </span>
                <span className="text-[11px] text-zinc-400">
                  {MODULE_LAYER_LABELS[module.layer as ModuleLayer] ?? module.layer}
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section title={`API 规划(${architecture.apis.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs text-zinc-400 dark:border-zinc-700">
                  <th className="py-2 pr-3 font-medium">方法</th>
                  <th className="py-2 pr-3 font-medium">路径</th>
                  <th className="py-2 pr-3 font-medium">模块</th>
                  <th className="py-2 pr-3 font-medium">说明</th>
                  <th className="py-2 font-medium">鉴权</th>
                </tr>
              </thead>
              <tbody>
                {architecture.apis.map((api, index) => (
                  <tr
                    key={`${api.method}-${api.path}-${index}`}
                    className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800"
                  >
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${METHOD_COLORS[api.method] ?? ""}`}
                      >
                        {api.method}
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                      {api.path}
                    </td>
                    <td className="py-2 pr-3 text-xs text-zinc-500 dark:text-zinc-400">
                      {api.module}
                    </td>
                    <td className="py-2 pr-3 text-xs text-zinc-500 dark:text-zinc-400">
                      {api.summary}
                    </td>
                    <td className="py-2 text-xs">
                      {api.requiresAuth ? (
                        <span className="text-emerald-600 dark:text-emerald-400">需要</span>
                      ) : (
                        <span className="text-zinc-400">公开</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="权限设计">
          <div className="grid gap-2 sm:grid-cols-2">
            {architecture.permissions.map((rule, index) => (
              <div
                key={`${rule.role}-${rule.resource}-${rule.action}-${index}`}
                className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-700"
              >
                <p className="text-sm">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                    {rule.role}
                  </span>
                  <span className="mx-1.5 text-zinc-400">·</span>
                  <span className="font-mono text-xs text-zinc-600 dark:text-zinc-300">
                    {rule.resource}:{rule.action}
                  </span>
                </p>
                {rule.note ? (
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {rule.note}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </Section>

        <Section title="项目目录结构">
          <pre className="overflow-x-auto rounded-md bg-zinc-50 p-4 font-mono text-xs leading-relaxed text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            {architecture.directoryTree}
          </pre>
        </Section>

        <Section title="数据库设计">
          {db ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {db.engine} · {db.tables.length} 张表 · {db.relations.length} 组表关系
                </p>
                <div className="flex items-center gap-2">
                  {!confirmed ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void regenerateDatabase()}
                      disabled={regeneratingDb}
                    >
                      <SparklesIcon className="h-3.5 w-3.5" />
                      {regeneratingDb ? "重新生成中…" : "AI 重新设计数据库"}
                    </Button>
                  ) : null}
                  <Link
                    href={`/projects/${projectId}/database`}
                    className="flex items-center gap-1 text-sm font-medium text-violet-600 hover:underline dark:text-violet-400"
                  >
                    查看 ER 图
                    <ChevronRightIcon className="h-4 w-4" />
                  </Link>
                </div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {db.tables.map((table) => (
                  <div
                    key={table.name}
                    className="rounded-md border border-zinc-200 dark:border-zinc-700"
                  >
                    <div className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
                      <p className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {table.name}
                      </p>
                      <p className="mt-0.5 line-clamp-1 text-[11px] text-zinc-400">
                        {table.description}
                      </p>
                    </div>
                    <ul className="px-3 py-2 font-mono text-[11px] leading-relaxed">
                      {table.fields.slice(0, 6).map((field) => (
                        <li key={field.name} className="flex items-center gap-1.5">
                          <span className="text-zinc-700 dark:text-zinc-300">
                            {field.name}
                          </span>
                          <span className="text-zinc-400">{field.type}</span>
                          {field.isPrimary ? <span className="text-amber-500">PK</span> : null}
                        </li>
                      ))}
                      {table.fields.length > 6 ? (
                        <li className="text-zinc-400">…共 {table.fields.length} 个字段</li>
                      ) : null}
                    </ul>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-zinc-400">未生成数据库设计</p>
          )}
        </Section>
      </div>
    </div>
  );
}
