"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** 展示型 + 可编辑字符串列表区块,供非功能需求 / 边界 / 目标复用。 */

export function SectionCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function StringListSection({
  items,
  onChange,
  addPlaceholder,
}: {
  items: string[];
  onChange: (items: string[]) => void | Promise<void>;
  addPlaceholder: string;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const value = draft.trim();
    if (!value) return;
    setDraft("");
    void onChange([...items, value]);
  }

  return (
    <div>
      {items.length > 0 ? (
        <ul className="space-y-1.5">
          {items.map((item, index) => (
            <li
              key={`${item}-${index}`}
              className="group flex items-start justify-between gap-3 rounded-lg px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/50"
            >
              <span className="leading-relaxed">{item}</span>
              <button
                type="button"
                aria-label={`删除:${item}`}
                className="shrink-0 rounded px-1.5 text-zinc-400 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                onClick={() => void onChange(items.filter((_, i) => i !== index))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 py-1.5 text-sm text-zinc-400">暂无内容</p>
      )}

      <div className="mt-2 flex gap-2">
        <Input
          value={draft}
          placeholder={addPlaceholder}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button variant="secondary" size="md" disabled={!draft.trim()} onClick={add}>
          添加
        </Button>
      </div>
    </div>
  );
}

export function FlowsSection({ flows }: { flows: Array<{ name: string; steps: string[] }> }) {
  if (flows.length === 0) {
    return <p className="text-sm text-zinc-400">暂无业务流程(重新运行 AI 分析可生成)</p>;
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {flows.map((flow) => (
        <div
          key={flow.name}
          className="rounded-md border border-zinc-200 p-4 dark:border-zinc-700"
        >
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {flow.name}
          </p>
          <ol className="mt-2.5 space-y-1.5">
            {flow.steps.map((step, index) => (
              <li
                key={`${flow.name}-${index}`}
                className="flex items-start gap-2 text-sm text-zinc-500 dark:text-zinc-400"
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[10px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

export function TasksSection({ tasks }: { tasks: Array<{ title: string; description: string }> }) {
  if (tasks.length === 0) {
    return <p className="text-sm text-zinc-400">暂无开发任务(重新运行 AI 分析可生成)</p>;
  }
  return (
    <ol className="space-y-2">
      {tasks.map((task, index) => (
        <li
          key={`${task.title}-${index}`}
          className="flex items-start gap-3 rounded-md border border-zinc-100 px-4 py-3 dark:border-zinc-800"
        >
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-violet-600/10 text-[11px] font-semibold text-violet-700 dark:text-violet-400">
            {index + 1}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {task.title}
            </p>
            {task.description ? (
              <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
                {task.description}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
