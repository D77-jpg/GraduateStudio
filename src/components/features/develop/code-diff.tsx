"use client";

import { useEffect, useMemo, useRef } from "react";
import { MergeView } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";

/** 基于 @codemirror/merge 的双栏 Diff 视图(变更集审阅用)。 */

export function CodeDiff({
  before,
  after,
  height = 260,
}: {
  before: string;
  after: string;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const view = new MergeView({
      a: { doc: before },
      b: { doc: after },
      parent: container,
      revertControls: "a-to-b",
      highlightChanges: true,
      gutter: true,
    });

    const gutters = container.querySelectorAll<HTMLElement>(".cm-mergeViewEditors");
    gutters.forEach((el) => {
      el.style.height = `${height}px`;
      el.style.overflow = "auto";
    });

    return () => view.destroy();
  }, [before, after, height]);

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded-lg border border-zinc-200 text-xs dark:border-zinc-700"
    />
  );
}

export function useEditorTheme() {
  return useMemo(
    () =>
      EditorView.theme({
        "&": { fontSize: "13px" },
        ".cm-gutters": { borderRight: "none" },
      }),
    [],
  );
}
