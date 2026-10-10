"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileCodeIcon, RefreshIcon, SparklesIcon } from "@/components/icons";

/**
 * Phase 9:AI 毕业设计文档中心。
 * 左:文档列表 + 章节树;中:章节内容(可编辑);右:AI 操作 + 版本快照。
 * 生成内容来源于项目真实数据;同步提示基于依赖快照(stale 检测)。
 */

interface DocumentListItem {
  id: string;
  type: string;
  title: string;
  status: string;
  updatedAt: string;
  totalSections: number;
  generatedSections: number;
}

interface SectionItem {
  id: string;
  key: string;
  title: string;
  content: string;
  order: number;
  generatedAt: string | null;
  updatedAt: string;
  staleReason: string | null;
}

interface VersionItem {
  id: string;
  version: number;
  changeReason: string;
  createdAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  THESIS: "说明书",
  OPENING_REPORT: "开题报告",
  TASK_BOOK: "任务书",
  LITERATURE_REVIEW: "文献综述",
};

const MODE_LABELS: Record<string, string> = {
  polish: "AI 润色",
  expand: "AI 扩写",
  condense: "AI 缩写",
};

export function DocumentsView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [generatingAll, setGeneratingAll] = useState(false);

  const listQuery = useQuery({
    queryKey: ["documents", projectId],
    queryFn: () =>
      apiJson<{ documents: DocumentListItem[] }>(`/api/projects/${projectId}/documents`),
  });
  const docs = listQuery.data?.documents ?? [];
  const activeDoc = docs.find((d) => d.id === activeDocId) ?? docs[0] ?? null;

  const detailQuery = useQuery({
    queryKey: ["documents", projectId, activeDoc?.id ?? "none"],
    queryFn: () =>
      apiJson<{ document: DocumentListItem; sections: SectionItem[]; versions: VersionItem[] }>(
        `/api/projects/${projectId}/documents/${activeDoc!.id}`,
      ),
    enabled: Boolean(activeDoc),
  });
  const sections = useMemo(() => detailQuery.data?.sections ?? [], [detailQuery.data]);
  const versions = detailQuery.data?.versions ?? [];
  const activeSection = sections.find((s) => s.id === activeSectionId) ?? sections[0] ?? null;

  const staleCount = useMemo(() => sections.filter((s) => s.staleReason).length, [sections]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["documents", projectId] });
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

  const createDoc = (type: string) =>
    run(`create-${type}`, async () => {
      const data = await apiJson<{ document: { id: string } }>(
        `/api/projects/${projectId}/documents`,
        {
          method: "POST",
          body: JSON.stringify({ type }),
        },
      );
      setActiveDocId(data.document.id);
    });

  const generateSection = (sectionId: string) =>
    run(`gen-${sectionId}`, async () => {
      await apiJson(`/api/projects/${projectId}/documents/${activeDoc!.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "generate-section", sectionId }),
      });
      setNotice("章节已生成");
    });

  const editSection = (sectionId: string, mode: "polish" | "expand" | "condense") =>
    run(`edit-${sectionId}-${mode}`, async () => {
      await apiJson(`/api/projects/${projectId}/documents/${activeDoc!.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "edit-section", sectionId, mode }),
      });
      setNotice(`${MODE_LABELS[mode]}完成`);
    });

  const saveSection = (sectionId: string, content: string) =>
    run("save", async () => {
      await apiJson(`/api/projects/${projectId}/documents/${activeDoc!.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "save-section", sectionId, content }),
      });
      setNotice("已保存");
    });

  const snapshot = () =>
    run("snapshot", async () => {
      const reason = `手动快照 ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
      const data = await apiJson<{ version: VersionItem }>(
        `/api/projects/${projectId}/documents/${activeDoc!.id}`,
        {
          method: "POST",
          body: JSON.stringify({ action: "snapshot", changeReason: reason }),
        },
      );
      setNotice(`已保存版本 v${data.version.version}`);
    });

  const restoreVersion = (versionId: string, v: number) =>
    run(`restore-${versionId}`, async () => {
      await apiJson(`/api/projects/${projectId}/documents/${activeDoc!.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "restore-version", versionId }),
      });
      setNotice(`已恢复到 v${v}(恢复前的内容已自动备份)`);
    });

  /** 顺序生成全部未生成章节(前端驱动,逐章落库,可中断后续手动继续) */
  async function generateAll() {
    if (!activeDoc) return;
    setGeneratingAll(true);
    setError(null);
    try {
      const pending = sections.filter(
        (s) => !s.content.trim() && !["toc", "abstract-en"].includes(s.key),
      );
      for (let i = 0; i < pending.length; i++) {
        setBusy(`gen-all-${pending[i].id}`);
        await apiJson(`/api/projects/${projectId}/documents/${activeDoc.id}`, {
          method: "POST",
          body: JSON.stringify({ action: "generate-section", sectionId: pending[i].id }),
        });
        refresh();
      }
      setNotice(`批量生成完成(${pending.length} 章)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "批量生成中断,可点单章重试");
    } finally {
      setGeneratingAll(false);
      setBusy(null);
    }
  }

  if (listQuery.isPending) {
    return (
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[260px_minmax(0,1fr)_260px]">
      {/* 左:文档列表 + 章节树 */}
      <aside className="space-y-4 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div>
          <p className="mb-2 px-1 text-xs font-semibold text-zinc-500">文档</p>
          {docs.length === 0 ? (
            <p className="px-1 py-2 text-xs text-zinc-400">还没有文档,从下面创建</p>
          ) : (
            <div className="space-y-1">
              {docs.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => {
                    setActiveDocId(doc.id);
                    setActiveSectionId(null);
                  }}
                  className={`block w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                    activeDoc?.id === doc.id
                      ? "bg-violet-600/10 text-violet-700 dark:text-violet-300"
                      : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/70"
                  }`}
                >
                  <span className="block truncate text-xs font-medium">{doc.title}</span>
                  <span className="mt-0.5 block text-[10px] text-zinc-400">
                    {TYPE_LABELS[doc.type] ?? doc.type} · {doc.generatedSections}/
                    {doc.totalSections} 章
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <p className="mb-1.5 px-1 text-xs font-semibold text-zinc-500">新建文档</p>
          <div className="flex flex-wrap gap-1 px-1">
            {Object.entries(TYPE_LABELS).map(([type, label]) => (
              <button
                key={type}
                type="button"
                disabled={busy !== null || docs.some((d) => d.type === type)}
                onClick={() => void createDoc(type)}
                className="rounded-md border border-zinc-200 px-2 py-1 text-[11px] text-zinc-600 transition-colors hover:border-violet-400 hover:text-violet-700 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-violet-500/40"
              >
                + {label}
              </button>
            ))}
          </div>
        </div>

        {activeDoc && sections.length > 0 ? (
          <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <div className="mb-1.5 flex items-center justify-between px-1">
              <p className="text-xs font-semibold text-zinc-500">章节</p>
              {staleCount > 0 ? <Badge tone="danger">{staleCount} 章需同步</Badge> : null}
            </div>
            <div className="max-h-80 space-y-0.5 overflow-y-auto">
              {sections.map((section) => {
                const generated = Boolean(section.content.trim());
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => setActiveSectionId(section.id)}
                    className={`block w-full rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                      activeSection?.id === section.id
                        ? "bg-violet-600/10 text-violet-700 dark:text-violet-300"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/70"
                    }`}
                  >
                    <span className="flex items-center gap-1.5 text-xs">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          generated ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate">{section.title}</span>
                    </span>
                    {section.staleReason ? (
                      <span className="mt-0.5 block truncate pl-3 text-[10px] text-red-500">
                        {section.staleReason}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </aside>

      {/* 中:章节编辑器 */}
      <section className="flex min-h-[32rem] flex-col overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60">
        <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {activeSection ? activeSection.title : activeDoc ? activeDoc.title : "文档中心"}
          </h2>
          {activeDoc ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={generatingAll || busy !== null}
                onClick={() => void generateAll()}
              >
                {generatingAll
                  ? `生成中(${busy?.startsWith("gen-all") ? "…" : ""})`
                  : "AI 生成全部章节"}
              </Button>
              <a
                href={`/api/projects/${projectId}/documents/${activeDoc.id}/export?format=md`}
                className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-600 transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-400"
              >
                导出 MD
              </a>
              <a
                href={`/api/projects/${projectId}/documents/${activeDoc.id}/export?format=docx`}
                className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-600 transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-400"
              >
                导出 DOCX
              </a>
              <button
                type="button"
                onClick={() => window.print()}
                className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-600 transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-400"
                title="浏览器打印对话框可选『另存为 PDF』"
              >
                打印/PDF
              </button>
            </>
          ) : null}
        </header>

        {error ? (
          <p className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
            {notice}
          </p>
        ) : null}
        {activeSection?.staleReason ? (
          <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
            项目数据已变化({activeSection.staleReason}),建议点击右侧「重新生成」同步最新内容。
          </p>
        ) : null}

        {activeSection ? (
          <SectionEditor
            key={activeSection.id}
            section={activeSection}
            saving={busy === "save"}
            onSave={(content) => void saveSection(activeSection.id, content)}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <SparklesIcon className="h-8 w-8 text-violet-400" />
            <p className="max-w-sm text-sm text-zinc-500">
              {activeDoc
                ? "从左侧选择章节,或点击「AI 生成全部章节」。生成内容来源于项目的需求、架构、数据库、代码、测试与版本历史等真实数据。"
                : "先创建一个文档(如毕业设计说明书),AI 将依据项目真实数据逐章生成。"}
            </p>
          </div>
        )}
      </section>

      {/* 右:AI 操作 + 版本 */}
      <aside className="space-y-4">
        {activeSection ? (
          <div className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
            <p className="mb-2 px-1 text-xs font-semibold text-zinc-500">
              AI 操作 · {activeSection.title}
            </p>
            <div className="space-y-1.5">
              <Button
                variant="primary"
                size="sm"
                className="w-full"
                disabled={busy !== null || generatingAll}
                onClick={() => void generateSection(activeSection.id)}
              >
                {busy === `gen-${activeSection.id}`
                  ? "生成中…"
                  : activeSection.content.trim()
                    ? "重新生成"
                    : "AI 生成本章节"}
              </Button>
              <div className="grid grid-cols-3 gap-1.5">
                {(["polish", "expand", "condense"] as const).map((mode) => (
                  <Button
                    key={mode}
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null || generatingAll || !activeSection.content.trim()}
                    onClick={() => void editSection(activeSection.id, mode)}
                  >
                    {busy === `edit-${activeSection.id}-${mode}`
                      ? "…"
                      : MODE_LABELS[mode].replace("AI ", "")}
                  </Button>
                ))}
              </div>
              <p className="px-1 pt-1 text-[10px] leading-relaxed text-zinc-400">
                生成依据:
                {activeSection.title.includes("数据库")
                  ? "数据库设计"
                  : "项目需求/架构/代码/测试等真实数据"}
                ;润色/扩写/缩写保持技术事实不变。
              </p>
            </div>
          </div>
        ) : null}

        {activeDoc ? (
          <div className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
            <div className="mb-2 flex items-center justify-between px-1">
              <p className="text-xs font-semibold text-zinc-500">版本快照</p>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => void snapshot()}
              >
                {busy === "snapshot" ? "…" : "保存快照"}
              </Button>
            </div>
            {versions.length === 0 ? (
              <p className="px-1 py-2 text-xs text-zinc-400">还没有版本快照</p>
            ) : (
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {versions.map((v) => (
                  <div
                    key={v.id}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  >
                    <Badge tone="neutral">v{v.version}</Badge>
                    <span
                      className="min-w-0 flex-1 truncate text-[11px] text-zinc-500"
                      title={v.changeReason}
                    >
                      {v.changeReason}
                    </span>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void restoreVersion(v.id, v.version)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-violet-600 hover:bg-violet-50 disabled:opacity-50 dark:text-violet-400 dark:hover:bg-violet-500/10"
                    >
                      恢复
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        <div className="rounded-md border border-zinc-200 bg-white p-3 text-[11px] leading-relaxed text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/60">
          <p className="mb-1 flex items-center gap-1 font-semibold text-zinc-500">
            <FileCodeIcon className="h-3.5 w-3.5" />
            数据来源
          </p>
          需求分析 → 引言/需求分析章节;架构 → 相关技术/系统设计;数据库 → 数据库设计;代码 →
          系统实现;测试记录 → 系统测试;版本历史 →
          总结。项目变化后章节会标记「需同步」,确认后重新生成即可。
          <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={refresh}>
            <RefreshIcon className="h-3.5 w-3.5" />
            刷新文档状态
          </Button>
        </div>
      </aside>
    </div>
  );
}

/** 章节编辑器:key 按章节 id 挂载,draft 状态随之初始化,避免 effect 同步。 */
function SectionEditor({
  section,
  saving,
  onSave,
}: {
  section: SectionItem;
  saving: boolean;
  onSave: (content: string) => void;
}) {
  const [draft, setDraft] = useState(section.content);
  const dirty = draft !== section.content;
  return (
    <>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="章节内容(Markdown)。点击右侧「生成」让 AI 依据项目真实数据撰写,或直接手动编辑。"
        className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed text-zinc-800 outline-none dark:text-zinc-200"
        spellCheck={false}
      />
      <div className="flex items-center gap-2 border-t border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <span className="text-[11px] text-zinc-400">
          {draft.length} 字{dirty ? " · 未保存" : ""}
          {section.generatedAt
            ? ` · 生成于 ${new Date(section.generatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
            : ""}
        </span>
        <Button
          variant={dirty ? "primary" : "secondary"}
          size="sm"
          className="ml-auto"
          disabled={!dirty || saving}
          onClick={() => onSave(draft)}
        >
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>
    </>
  );
}
