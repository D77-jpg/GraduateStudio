"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import type {
  ActivityLogDto,
  ChangeSetDto,
  FileContentDto,
  FileNodeDto,
  SearchResultDto,
} from "@/lib/develop";
import type { ProjectDto } from "@/lib/projects";
import { FileTree } from "./file-tree";
import { EditorPane, type EditorTabState } from "./editor-pane";
import { BottomPanel } from "./bottom-panel";
import { AgentPanel } from "./agent-panel";
import { ChevronRightIcon } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";

type LeftTab = "files" | "search";

const clampWidth = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 栏间拖拽分隔条:拖动调整相邻栏宽度,双击复位。 */
function ColumnResizeHandle({
  onDelta,
  onReset,
  ariaLabel,
  className = "hidden shrink-0 cursor-col-resize touch-none items-stretch justify-center w-1.5 transition-colors hover:bg-violet-500/20 md:flex",
}: {
  onDelta: (dx: number) => void;
  onReset: () => void;
  ariaLabel: string;
  className?: string;
}) {
  const lastX = useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      title="拖动调整宽度 · 双击复位"
      className={`relative ${className}`}
      onPointerDown={(event) => {
        lastX.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (lastX.current === null) return;
        const dx = event.clientX - lastX.current;
        lastX.current = event.clientX;
        onDelta(dx);
      }}
      onPointerUp={(event) => {
        lastX.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onDoubleClick={onReset}
    >
      <span className="h-full w-px bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}

function LeftPanel({
  projectId,
  tree,
  treeLoading,
  activePath,
  onOpen,
}: {
  projectId: string;
  tree: FileNodeDto[];
  treeLoading: boolean;
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const [tab, setTab] = useState<LeftTab>("files");
  const [fileFilter, setFileFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<SearchResultDto | null>(null);
  const [searching, setSearching] = useState(false);

  const fileMatches = fileFilter.trim()
    ? tree.filter(
        (node) =>
          node.type === "file" && node.path.toLowerCase().includes(fileFilter.trim().toLowerCase()),
      )
    : null;

  async function runSearch() {
    const query = searchQuery.trim();
    if (!query) return;
    setSearching(true);
    try {
      setSearchResult(
        await apiJson<SearchResultDto>(
          `/api/projects/${projectId}/search?q=${encodeURIComponent(query)}`,
        ),
      );
    } catch {
      setSearchResult(null);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
        {(
          [
            { key: "files", label: "文件" },
            { key: "search", label: "搜索" },
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

      {tab === "files" ? (
        <>
          <div className="p-2">
            <input
              value={fileFilter}
              onChange={(event) => setFileFilter(event.target.value)}
              placeholder="按文件名过滤…"
              className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500"
            />
          </div>
          {treeLoading ? (
            <div className="space-y-1.5 p-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-5" />
              ))}
            </div>
          ) : fileMatches ? (
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {fileMatches.length === 0 ? (
                <p className="px-3 py-4 text-xs text-zinc-400">无匹配文件</p>
              ) : (
                fileMatches.map((node) => (
                  <button
                    key={node.path}
                    type="button"
                    onClick={() => onOpen(node.path)}
                    className={`block w-full truncate rounded-md px-3 py-1 text-left text-xs font-mono transition-colors ${
                      node.path === activePath
                        ? "bg-violet-600/10 text-violet-700 dark:text-violet-300"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/70"
                    }`}
                    title={node.path}
                  >
                    {node.path}
                  </button>
                ))
              )}
            </div>
          ) : (
            <FileTree tree={tree} activePath={activePath} onOpen={onOpen} />
          )}
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex gap-1.5 p-2">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void runSearch();
              }}
              placeholder="全局内容搜索…"
              className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500"
            />
            <button
              type="button"
              onClick={() => void runSearch()}
              disabled={searching || !searchQuery.trim()}
              className="shrink-0 rounded-lg bg-zinc-900 px-2.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
            >
              {searching ? "…" : "搜索"}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {!searchResult ? (
              <p className="px-1 py-3 text-xs text-zinc-400">搜索文件内容(回车执行)</p>
            ) : searchResult.hits.length === 0 ? (
              <p className="px-1 py-3 text-xs text-zinc-400">无匹配结果</p>
            ) : (
              <>
                <p className="px-1 py-1 text-[11px] text-zinc-400">
                  {searchResult.totalMatches} 处匹配{searchResult.truncated ? "(已截断)" : ""}
                </p>
                {searchResult.hits.map((hit, index) => (
                  <button
                    key={`${hit.path}-${hit.line}-${index}`}
                    type="button"
                    onClick={() => onOpen(hit.path)}
                    className="mb-1 block w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-left transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-600"
                  >
                    <p className="truncate font-mono text-[11px] text-violet-600 dark:text-violet-400">
                      {hit.path}:{hit.line}
                    </p>
                    <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                      {hit.text}
                    </p>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function DevelopWorkspace({ project }: { project: ProjectDto }) {
  const queryClient = useQueryClient();
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [leftWidth, setLeftWidth] = useState(256);
  const [rightWidth, setRightWidth] = useState(400);
  const leftDefault = 256;
  const rightDefault = 400;

  const treeQuery = useQuery({
    queryKey: ["files", project.id],
    queryFn: () =>
      apiJson<{ tree: FileNodeDto[]; scaffolded: boolean }>(`/api/projects/${project.id}/files`),
  });

  const changesetsQuery = useQuery({
    queryKey: ["changesets", project.id],
    queryFn: () =>
      apiJson<{ changeSets: ChangeSetDto[] }>(`/api/projects/${project.id}/changesets`),
  });

  const logsQuery = useQuery({
    queryKey: ["logs", project.id],
    queryFn: () => apiJson<{ logs: ActivityLogDto[] }>(`/api/projects/${project.id}/logs`),
  });

  const tree = treeQuery.data?.tree ?? [];
  const changeSets = changesetsQuery.data?.changeSets ?? [];
  const pendingChangeSet = changeSets.find((cs) => cs.status === "pending") ?? null;
  const history = changeSets.filter((cs) => cs.status !== "pending");

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["files", project.id] });
    void queryClient.invalidateQueries({ queryKey: ["changesets", project.id] });
    void queryClient.invalidateQueries({ queryKey: ["logs", project.id] });
  }, [queryClient, project.id]);

  async function openFile(path: string) {
    setActivePath(path);
    if (openTabs.includes(path)) return;
    if (contents[path] !== undefined) {
      setOpenTabs((prev) => [...prev, path]);
      return;
    }
    try {
      const data = await apiJson<{ file: FileContentDto }>(
        `/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`,
      );
      setContents((prev) => ({ ...prev, [data.file.path]: data.file.content }));
      setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "打开文件失败");
    }
  }

  function onChangeContent(value: string) {
    if (!activePath) return;
    setContents((prev) => ({ ...prev, [activePath]: value }));
    setDirty((prev) => new Set(prev).add(activePath));
  }

  async function saveActive() {
    if (!activePath || saving) return;
    setSaving(true);
    try {
      await apiJson(`/api/projects/${project.id}/file`, {
        method: "PUT",
        body: JSON.stringify({ path: activePath, content: contents[activePath] ?? "" }),
      });
      setDirty((prev) => {
        const next = new Set(prev);
        next.delete(activePath);
        return next;
      });
      refresh();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  function closeTab(path: string) {
    setOpenTabs((prev) => prev.filter((p) => p !== path));
    if (activePath === path) {
      const rest = openTabs.filter((p) => p !== path);
      setActivePath(rest.length > 0 ? rest[rest.length - 1] : null);
    }
  }

  const tabs: EditorTabState[] = openTabs.map((path) => ({
    path,
    dirty: dirty.has(path),
  }));

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-w-0">
      {/* 左:文件树 / 搜索 */}
      <aside
        className="hidden shrink-0 border-r border-zinc-200 md:block dark:border-zinc-800"
        style={{ width: leftWidth }}
      >
        <LeftPanel
          projectId={project.id}
          tree={tree}
          treeLoading={treeQuery.isPending}
          activePath={activePath}
          onOpen={(path) => void openFile(path)}
        />
      </aside>

      <ColumnResizeHandle
        ariaLabel="调整文件树宽度"
        onDelta={(dx) => setLeftWidth((w) => clampWidth(w + dx, 180, 480))}
        onReset={() => setLeftWidth(leftDefault)}
      />

      {/* 中:编辑器 + 底部面板 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {loadError ? (
          <p className="bg-red-50 px-4 py-1.5 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-400">
            {loadError}
          </p>
        ) : null}
        <EditorPane
          tabs={tabs}
          activePath={activePath}
          content={activePath ? (contents[activePath] ?? "") : ""}
          saving={saving}
          onSelect={setActivePath}
          onClose={closeTab}
          onChange={onChangeContent}
          onSave={() => void saveActive()}
        />
        <BottomPanel
          projectId={project.id}
          logs={logsQuery.data?.logs ?? []}
          onActivity={refresh}
        />
      </div>

      <ColumnResizeHandle
        ariaLabel="调整 AI 助手栏宽度"
        onDelta={(dx) => setRightWidth((w) => clampWidth(w - dx, 300, 680))}
        onReset={() => setRightWidth(rightDefault)}
        className="hidden shrink-0 cursor-col-resize touch-none items-stretch justify-center w-1.5 transition-colors hover:bg-violet-500/20 lg:flex"
      />

      {/* 右:AI Agent */}
      <aside
        className="hidden shrink-0 border-l border-zinc-200 lg:block dark:border-zinc-800"
        style={{ width: rightWidth }}
      >
        <AgentPanel
          projectId={project.id}
          pendingChangeSet={pendingChangeSet}
          history={history}
          activePath={activePath}
          onRefresh={refresh}
          onOpenFile={(path) => void openFile(path)}
        />
      </aside>
    </div>
  );
}

export function DevelopBreadcrumb({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
      <Link href="/dashboard" className="hover:text-zinc-900 dark:hover:text-zinc-200">
        工作台
      </Link>
      <ChevronRightIcon className="h-3 w-3" />
      <Link
        href={`/projects/${projectId}`}
        className="max-w-64 truncate hover:text-zinc-900 dark:hover:text-zinc-200"
      >
        {projectName}
      </Link>
      <ChevronRightIcon className="h-3 w-3" />
      <span className="text-zinc-700 dark:text-zinc-300">开发工作区</span>
    </div>
  );
}
