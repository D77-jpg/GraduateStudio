"use client";

import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { sql } from "@codemirror/lang-sql";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEditorTheme } from "./code-diff";
import { XIcon } from "@/components/icons";

function languageExtension(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "ts":
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "py":
      return [python()];
    case "java":
      return [java()];
    case "json":
      return [json()];
    case "html":
    case "htm":
    case "vue":
      return [html()];
    case "css":
    case "scss":
      return [css()];
    case "md":
      return [markdown()];
    case "sql":
      return [sql()];
    default:
      return [];
  }
}

export interface EditorTabState {
  path: string;
  dirty: boolean;
}

export function EditorPane({
  tabs,
  activePath,
  content,
  saving,
  onSelect,
  onClose,
  onChange,
  onSave,
}: {
  tabs: EditorTabState[];
  activePath: string | null;
  content: string;
  saving: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const theme = useEditorTheme();
  const extensions = useMemo(
    () => [EditorView.lineWrapping, theme, ...(activePath ? languageExtension(activePath) : [])],
    [activePath, theme],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 打开的文件标签 */}
      <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50">
        {tabs.length === 0 ? (
          <span className="self-center px-4 text-xs text-zinc-400">未打开文件</span>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.path}
              className={`group flex items-center gap-1.5 border-r border-zinc-200 px-3 text-xs dark:border-zinc-800 ${
                tab.path === activePath
                  ? "bg-white font-medium text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(tab.path)}
                className="max-w-40 truncate"
              >
                {tab.path.split("/").pop()}
              </button>
              {tab.dirty ? (
                <span className="h-1.5 w-1.5 rounded-full bg-violet-500" title="未保存" />
              ) : null}
              <button
                type="button"
                aria-label={`关闭 ${tab.path}`}
                onClick={() => onClose(tab.path)}
                className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>

      {activePath ? (
        <>
          <div
            className="min-h-0 flex-1 overflow-hidden [&>div]:h-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                onSave();
              }
            }}
          >
            <CodeMirror
              value={content}
              height="100%"
              theme="light"
              extensions={extensions}
              onChange={onChange}
              basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: true }}
            />
          </div>
          <div className="flex h-9 shrink-0 items-center justify-between border-t border-zinc-200 px-3 text-xs dark:border-zinc-800">
            <span className="truncate font-mono text-zinc-500 dark:text-zinc-400">
              {activePath}
            </span>
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="rounded-md bg-zinc-900 px-3 py-1 font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900"
            >
              {saving ? "保存中…" : "保存(Ctrl+S)"}
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400 dark:text-zinc-500">
          从左侧打开一个文件开始编辑
        </div>
      )}
    </div>
  );
}
