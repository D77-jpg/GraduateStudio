"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import type { ArchitectureDto, DatabaseTableDto } from "@/lib/architecture";
import { Skeleton } from "@/components/ui/skeleton";
import { ErCanvas } from "./er-canvas";

/**
 * ER 图(Chen 概念模型):sql2er CLI 从已确认架构生成 SVG,
 * ErCanvas 提供缩放/平移/节点拖动与 PNG/SVG 导出;下方为表字段与关系明细。
 */

function TableDetails({ tables }: { tables: DatabaseTableDto[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const active = tables.find((t) => t.name === selected) ?? null;

  return (
    <div className="mt-8">
      <div className="flex flex-wrap gap-2">
        {tables.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => setSelected(selected === t.name ? null : t.name)}
            className={`rounded-lg border px-3 py-1.5 font-mono text-xs transition-colors ${
              selected === t.name
                ? "border-violet-400 bg-violet-50 font-semibold text-violet-700 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300"
                : "border-zinc-200 text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600"
            }`}
          >
            {t.name}
          </button>
        ))}
      </div>

      {active ? (
        <div className="mt-4 rounded-2xl border border-violet-200 p-5 dark:border-violet-500/40">
          <p className="font-mono text-sm font-semibold text-violet-700 dark:text-violet-300">
            {active.name}
            <span className="ml-2 font-sans text-xs font-normal text-zinc-400">
              {active.description}
            </span>
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-zinc-400 dark:border-zinc-700">
                  <th className="py-1.5 pr-4 font-medium">字段</th>
                  <th className="py-1.5 pr-4 font-medium">类型</th>
                  <th className="py-1.5 pr-4 font-medium">约束</th>
                  <th className="py-1.5 font-medium">说明</th>
                </tr>
              </thead>
              <tbody>
                {active.fields.map((field) => (
                  <tr
                    key={field.name}
                    className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800"
                  >
                    <td className="py-1.5 pr-4 font-mono text-zinc-800 dark:text-zinc-200">
                      {field.name}
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-zinc-500">{field.type}</td>
                    <td className="py-1.5 pr-4 font-mono text-zinc-500">
                      {[
                        field.isPrimary ? "PK" : null,
                        field.isUnique ? "UNIQUE" : null,
                        field.nullable ? "NULL" : "NOT NULL",
                        field.defaultValue ? `DEFAULT ${field.defaultValue}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </td>
                    <td className="py-1.5 text-zinc-500">{field.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {active.indexes.length > 0 ? (
            <p className="mt-3 font-mono text-[11px] text-zinc-400">
              索引:{active.indexes.join(" ; ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ErDiagram({ projectId }: { projectId: string }) {
  const archQuery = useQuery({
    queryKey: ["architecture", projectId],
    queryFn: () =>
      apiJson<{ architecture: ArchitectureDto | null }>(`/api/projects/${projectId}/architecture`),
  });

  const erQuery = useQuery({
    queryKey: ["er-diagram", projectId],
    queryFn: () =>
      apiJson<{ svg: string | null; generatedAt?: string }>(
        `/api/projects/${projectId}/er-diagram`,
      ),
    staleTime: 5 * 60 * 1000,
  });

  const db = archQuery.data?.architecture?.database ?? null;

  const relationList = useMemo(() => {
    if (!db) return [];
    const nameSet = new Set(db.tables.map((t) => t.name));
    return db.relations.filter((r) => nameSet.has(r.fromTable) && nameSet.has(r.toTable));
  }, [db]);

  if (archQuery.isPending || erQuery.isPending) {
    return (
      <div aria-busy>
        <Skeleton className="h-10 w-96 rounded-lg" />
        <Skeleton className="mt-4 h-[520px] rounded-lg" />
        <p className="mt-3 text-xs text-zinc-400">正在生成 Chen 模型 ER 图(首次约需数秒)…</p>
      </div>
    );
  }

  if (!db || db.tables.length === 0 || erQuery.data?.svg == null) {
    const err = erQuery.error;
    const message =
      err instanceof Error && err.message.includes("er_not_configured")
        ? "未配置 sql2er CLI:请在 .env 设置 SQL2ER_AGENT(指向 sql2er-agent.mjs),并确认已安装 sql2er skill。"
        : err instanceof Error
          ? err.message
          : null;
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 p-12 text-center dark:border-zinc-700">
        <p className="font-medium text-zinc-900 dark:text-zinc-100">尚未生成 ER 图</p>
        <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
          {message ?? "先在「系统架构」页让 AI 生成架构与数据库设计,即可自动生成 Chen 模型 ER 图。"}
        </p>
      </div>
    );
  }

  // 调试开关:localStorage.erDebug='off' 时绕过交互画布(排查渲染崩溃用)
  const canvasDisabled = typeof window !== "undefined" && localStorage.getItem("erDebug") === "off";

  return (
    <div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Chen 概念模型 · {db.tables.length} 张表 · {db.relations.length} 组关系 · 由 sql2er
        从已确认架构自动生成
        {erQuery.data.generatedAt
          ? `,生成于 ${new Date(erQuery.data.generatedAt).toLocaleString("zh-CN")}`
          : ""}
      </p>

      {canvasDisabled ? (
        <div className="mt-4 overflow-auto rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-white">
          <div
            className="[&>svg]:h-auto [&>svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: erQuery.data.svg }}
          />
        </div>
      ) : (
        <div className="mt-4">
          <ErCanvas svg={erQuery.data.svg} />
        </div>
      )}

      <TableDetails tables={db.tables} />

      {relationList.length > 0 ? (
        <div className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            表关系明细
          </p>
          <ul className="mt-2 space-y-1 font-mono text-xs text-zinc-600 dark:text-zinc-400">
            {relationList.map((r) => {
              const fk = db.tables
                .find((t) => t.name === r.fromTable)
                ?.fields.find((f) => f.name === r.fromField);
              const kind =
                r.kind === "one-to-one" ? "1:1" : r.kind === "many-to-many" ? "M:N" : "1:N";
              return (
                <li key={`${r.fromTable}.${r.fromField}`}>
                  {r.fromTable}.{r.fromField} → {r.toTable} ({kind}
                  {fk?.nullable ? ", 可空" : ", 必填"})
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
