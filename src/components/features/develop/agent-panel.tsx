"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiJson } from "@/lib/api-client";
import {
  CHANGE_ACTION_LABELS,
  CHANGESET_STATUS_LABELS,
  type ChangeAction,
  type ChangeSetDto,
} from "@/lib/develop";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeDiff } from "./code-diff";
import { SparklesIcon, UndoIcon, RedoIcon } from "@/components/icons";

interface PlanStep {
  action: ChangeAction;
  path: string;
  reason?: string;
}

interface PlanDto {
  title: string;
  summary: string;
  steps: PlanStep[];
  risks: string;
}

interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  kind: "text" | "plan";
  text?: string;
  reasoning?: string;
  streaming?: boolean;
  error?: boolean;
  plan?: PlanDto;
}

function ActionBadge({ action }: { action: ChangeAction }) {
  return (
    <Badge tone={action === "create" ? "success" : action === "delete" ? "neutral" : "accent"}>
      {CHANGE_ACTION_LABELS[action]}
    </Badge>
  );
}

async function readSSE(response: Response, onEvent: (event: string, data: string) => void) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("无响应流");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      if (dataLines.length > 0) onEvent(event, dataLines.join("\n"));
    }
  }
}

export function AgentPanel({
  projectId,
  pendingChangeSet,
  history,
  activePath,
  onRefresh,
  onOpenFile,
}: {
  projectId: string;
  pendingChangeSet: ChangeSetDto | null;
  history: ChangeSetDto[];
  activePath: string | null;
  onRefresh: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [chatting, setChatting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [implementing, setImplementing] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);
  const [lastPlan, setLastPlan] = useState<{ message: string; plan: PlanDto } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function pushMessage(message: AgentMessage) {
    setMessages((prev) => [...prev, message]);
  }

  function patchLastMessage(patch: Partial<AgentMessage>) {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === "assistant") next[next.length - 1] = { ...last, ...patch };
      return next;
    });
  }

  async function sendChat() {
    const text = input.trim();
    if (!text || chatting) return;
    setInput("");
    pushMessage({ id: `u${Date.now()}`, role: "user", kind: "text", text });
    const assistantId = `a${Date.now()}`;
    pushMessage({
      id: assistantId,
      role: "assistant",
      kind: "text",
      text: "",
      reasoning: "",
      streaming: true,
    });
    setChatting(true);

    try {
      const response = await fetch(`/api/projects/${projectId}/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, selectedFilePaths: activePath ? [activePath] : [] }),
      });
      if (!response.ok) {
        let message = `请求失败(${response.status})`;
        try {
          const data = await response.json();
          if (data?.error?.message) message = data.error.message;
        } catch {
          /* keep default */
        }
        throw new Error(message);
      }

      let finalText = "";
      await readSSE(response, (event, data) => {
        if (event === "delta") {
          finalText += data;
          patchLastMessage({ text: finalText, streaming: true });
        } else if (event === "reasoning") {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + data };
            }
            return next;
          });
        } else if (event === "error") {
          throw new Error(data);
        }
      });
      patchLastMessage({ text: finalText || "(空响应)", streaming: false });
    } catch (error) {
      patchLastMessage({
        text: error instanceof Error ? error.message : "AI 调用失败",
        streaming: false,
        error: true,
      });
    } finally {
      setChatting(false);
    }
  }

  async function generatePlan() {
    const text = input.trim();
    if (!text || planning) return;
    setInput("");
    pushMessage({ id: `u${Date.now()}`, role: "user", kind: "text", text });
    setPlanning(true);
    try {
      const data = await apiJson<{ plan: PlanDto }>(`/api/projects/${projectId}/ai/plan`, {
        method: "POST",
        body: JSON.stringify({ message: text, selectedFilePaths: activePath ? [activePath] : [] }),
      });
      setLastPlan({ message: text, plan: data.plan });
      pushMessage({ id: `p${Date.now()}`, role: "assistant", kind: "plan", plan: data.plan });
    } catch (error) {
      pushMessage({
        id: `e${Date.now()}`,
        role: "assistant",
        kind: "text",
        text: error instanceof Error ? error.message : "生成计划失败",
        error: true,
      });
    } finally {
      setPlanning(false);
    }
  }

  async function implementPlan() {
    if (!lastPlan || implementing) return;
    setImplementing(true);
    try {
      const data = await apiJson<{ changeSet: ChangeSetDto }>(
        `/api/projects/${projectId}/ai/implement`,
        {
          method: "POST",
          body: JSON.stringify({
            message: lastPlan.message,
            plan: lastPlan.plan,
            selectedFilePaths: activePath ? [activePath] : [],
          }),
        },
      );
      pushMessage({
        id: `r${Date.now()}`,
        role: "assistant",
        kind: "text",
        text: `已生成待确认变更「${data.changeSet.title}」:${data.changeSet.changes.length} 个文件,请在上方审阅 Diff 后接受或拒绝。`,
      });
      onRefresh();
    } catch (error) {
      pushMessage({
        id: `e${Date.now()}`,
        role: "assistant",
        kind: "text",
        text: error instanceof Error ? error.message : "执行计划失败",
        error: true,
      });
    } finally {
      setImplementing(false);
    }
  }

  async function acceptChangeSet() {
    if (!pendingChangeSet || accepting) return;
    setAccepting(true);
    try {
      await apiJson(`/api/projects/${projectId}/changesets`, {
        method: "POST",
        body: JSON.stringify({ action: "accept", changeSetId: pendingChangeSet.id }),
      });
      onRefresh();
    } catch (error) {
      pushMessage({
        id: `e${Date.now()}`,
        role: "assistant",
        kind: "text",
        text: error instanceof Error ? error.message : "应用失败",
        error: true,
      });
    } finally {
      setAccepting(false);
    }
  }

  async function rejectChangeSet() {
    if (!pendingChangeSet) return;
    await apiJson(`/api/projects/${projectId}/changesets`, {
      method: "POST",
      body: JSON.stringify({ action: "reject", changeSetId: pendingChangeSet.id }),
    });
    onRefresh();
  }

  async function runChangeSetAction(action: "undo" | "restore", changeSetId?: string) {
    setUndoing(true);
    try {
      if (action === "undo") {
        await apiJson(`/api/projects/${projectId}/changesets`, {
          method: "POST",
          body: JSON.stringify({ action: "undo" }),
        });
      } else if (changeSetId) {
        await apiJson(`/api/projects/${projectId}/changesets`, {
          method: "PUT",
          body: JSON.stringify({ changeSetId }),
        });
      }
      onRefresh();
    } catch (error) {
      pushMessage({
        id: `e${Date.now()}`,
        role: "assistant",
        kind: "text",
        text: error instanceof Error ? error.message : "操作失败",
        error: true,
      });
    } finally {
      setUndoing(false);
    }
  }

  const latestAccepted = history.find((cs) => cs.status === "accepted");
  const latestUndone = history.find((cs) => cs.status === "undone");

  return (
    <div className="flex h-full flex-col">
      {/* 自主开发入口 */}
      <Link
        href={`/projects/${projectId}/agent`}
        className="flex shrink-0 items-center gap-2 border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500 transition-colors hover:bg-violet-50 hover:text-violet-700 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-violet-500/10 dark:hover:text-violet-300"
      >
        <SparklesIcon className="h-3.5 w-3.5" />
        切换到自主开发任务(Agent 闭环:分析→编码→自检→修复)
        <span className="ml-auto text-zinc-300">→</span>
      </Link>

      {/* 待确认变更审阅(置顶) */}
      {pendingChangeSet ? (
        <div className="shrink-0 border-b border-violet-200 bg-violet-50/60 p-3 dark:border-violet-500/30 dark:bg-violet-500/5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {pendingChangeSet.title}
              </p>
              <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
                {pendingChangeSet.summary}
              </p>
            </div>
            <Badge tone="accent">待确认</Badge>
          </div>

          <div className="mt-2 space-y-1.5">
            {pendingChangeSet.changes.map((change) => (
              <div
                key={change.id}
                className="rounded-lg border border-violet-200/70 bg-white dark:border-violet-500/20 dark:bg-zinc-900"
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
                  onClick={() => setExpandedDiff(expandedDiff === change.id ? null : change.id)}
                >
                  <ActionBadge action={change.action} />
                  <span className="min-w-0 flex-1 truncate font-mono text-zinc-700 dark:text-zinc-300">
                    {change.path}
                  </span>
                  <span className="text-zinc-400">
                    {expandedDiff === change.id ? "收起" : "Diff"}
                  </span>
                </button>
                {expandedDiff === change.id ? (
                  <div className="px-2 pb-2">
                    <CodeDiff
                      before={change.beforeContent ?? ""}
                      after={change.afterContent ?? ""}
                    />
                    {change.action !== "delete" && change.afterContent ? (
                      <button
                        type="button"
                        className="mt-1 text-[11px] text-violet-600 hover:underline dark:text-violet-400"
                        onClick={() => onOpenFile(change.path)}
                      >
                        在编辑器中打开 →
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="mt-2.5 flex gap-2">
            <Button size="sm" onClick={() => void acceptChangeSet()} disabled={accepting}>
              {accepting ? "应用中…" : "接受全部修改"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void rejectChangeSet()}>
              全部拒绝
            </Button>
          </div>
        </div>
      ) : null}

      {/* 对话区 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="rounded-md border border-dashed border-zinc-300 p-4 text-center dark:border-zinc-700">
            <SparklesIcon className="mx-auto h-5 w-5 text-violet-500" />
            <p className="mt-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
              AI 编码助手
            </p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              它了解项目的需求、功能树与文件结构。试着说:
              <br />
              「实现用户登录功能」→ 生成修改计划 → 审阅 Diff → 应用
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="mb-3">
              {message.role === "user" ? (
                <p className="rounded-md bg-zinc-100 px-3 py-2 text-sm text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                  {message.text}
                </p>
              ) : message.kind === "plan" && message.plan ? (
                <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
                  <div className="flex items-center gap-2">
                    <SparklesIcon className="h-4 w-4 text-violet-500" />
                    <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {message.plan.title}
                    </p>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                    {message.plan.summary}
                  </p>
                  <ol className="mt-2 space-y-1">
                    {message.plan.steps.map((step, index) => (
                      <li key={index} className="flex items-start gap-2 text-xs">
                        <ActionBadge action={step.action} />
                        <span className="min-w-0 flex-1">
                          <span className="font-mono text-zinc-700 dark:text-zinc-300">
                            {step.path}
                          </span>
                          {step.reason ? (
                            <span className="block text-zinc-500 dark:text-zinc-400">
                              {step.reason}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {message.plan.risks ? (
                    <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                      ⚠ {message.plan.risks}
                    </p>
                  ) : null}
                  {lastPlan?.plan.title === message.plan.title ? (
                    <Button
                      size="sm"
                      className="mt-2.5"
                      onClick={() => void implementPlan()}
                      disabled={implementing}
                    >
                      {implementing ? "生成代码中…(可能 1-3 分钟)" : "执行计划,生成代码"}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div>
                  {message.reasoning ? (
                    <details className="mb-1">
                      <summary className="cursor-pointer text-[11px] text-zinc-400">
                        思考过程
                      </summary>
                      <p className="mt-1 whitespace-pre-wrap rounded-lg bg-zinc-50 px-2 py-1.5 text-[11px] italic leading-relaxed text-zinc-400 dark:bg-zinc-800/60">
                        {message.reasoning}
                      </p>
                    </details>
                  ) : null}
                  <p
                    className={`whitespace-pre-wrap rounded-md px-3 py-2 text-sm leading-relaxed ${
                      message.error
                        ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400"
                        : "text-zinc-800 dark:text-zinc-200"
                    }`}
                  >
                    {message.text}
                    {message.streaming ? <span className="ml-0.5 animate-pulse">▍</span> : null}
                  </p>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* 变更历史 */}
      {history.length > 0 ? (
        <div className="max-h-40 shrink-0 overflow-y-auto border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">变更历史</p>
          <div className="mt-1.5 space-y-1">
            {history.slice(0, 6).map((cs) => (
              <div key={cs.id} className="flex items-center gap-2 text-xs">
                <Badge
                  tone={
                    cs.status === "accepted"
                      ? "success"
                      : cs.status === "undone"
                        ? "neutral"
                        : "neutral"
                  }
                >
                  {CHANGESET_STATUS_LABELS[cs.status]}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-400">
                  {cs.title}
                </span>
                {cs.status === "accepted" && cs.id === latestAccepted?.id ? (
                  <button
                    type="button"
                    disabled={undoing}
                    onClick={() => void runChangeSetAction("undo")}
                    className="flex items-center gap-1 text-violet-600 hover:underline disabled:opacity-50 dark:text-violet-400"
                  >
                    <UndoIcon className="h-3 w-3" />
                    撤销
                  </button>
                ) : null}
                {cs.status === "undone" && cs.id === latestUndone?.id ? (
                  <button
                    type="button"
                    disabled={undoing}
                    onClick={() => void runChangeSetAction("restore", cs.id)}
                    className="flex items-center gap-1 text-emerald-600 hover:underline disabled:opacity-50 dark:text-emerald-400"
                  >
                    <RedoIcon className="h-3 w-3" />
                    恢复
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 输入区 */}
      <div className="shrink-0 border-t border-zinc-200 p-3 dark:border-zinc-800">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendChat();
            }
          }}
          rows={2}
          placeholder={activePath ? `当前文件:${activePath}\n描述任务或提问…` : "描述你的开发任务…"}
          className="w-full resize-none rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-500"
        />
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => void sendChat()} disabled={!input.trim() || chatting}>
            {chatting ? "回答中…" : "发送"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void generatePlan()}
            disabled={!input.trim() || planning}
          >
            <SparklesIcon className="h-3.5 w-3.5" />
            {planning ? "规划中…" : "生成修改计划"}
          </Button>
        </div>
      </div>
    </div>
  );
}
