"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SparklesIcon } from "@/components/icons";

/**
 * Phase 10:AI 毕业答辩中心。
 * 知识库概览 → AI 出题 / PPT 结构 → 模拟答辩(评分+追问) → 准备度报告。
 * 问题与评分全部基于项目真实数据(需求/架构/数据库/代码/测试/版本历史)。
 */

interface QuestionItem {
  id: string;
  category: string;
  question: string;
  expectedPoints: string[];
  difficulty: string;
  status: string;
}

interface TurnItem {
  id: string;
  index: number;
  question: string;
  category: string;
  isFollowup: boolean;
  answer: string;
  scores: Record<string, unknown> | null;
  comment: string;
}

interface StoredWeakPoint {
  area: string;
  issue: string;
  suggestion: string;
}

interface StoredDimension {
  name: string;
  score: number;
  comment: string;
}

interface SessionItem {
  id: string;
  status: string;
  overallScore: number | null;
  summary: string;
  weakPoints: StoredWeakPoint[];
  dimensions: StoredDimension[];
  createdAt: string;
  turns: TurnItem[];
}

interface PptSlide {
  title: string;
  bullets: string[];
  talkingPoints: string;
  suggestedVisual: string;
}

interface PptOutline {
  title: string;
  slides: PptSlide[];
}

interface Knowledge {
  project: { name: string; type: string; techStack: string[]; difficulty: string | null };
  counts: Record<string, number | null>;
  highlights: string[];
}

interface ReportScore {
  readiness?: number;
  technicalUnderstanding?: number;
  projectUnderstanding?: number;
  completeness?: number;
  professionalism?: number;
  clarity?: number;
  overall?: number;
  comment?: string;
  followup?: { question: string; reason: string } | null;
}

const DIMENSIONS: Array<{ key: keyof ReportScore; label: string }> = [
  { key: "technicalUnderstanding", label: "技术理解" },
  { key: "projectUnderstanding", label: "项目理解" },
  { key: "completeness", label: "回答完整度" },
  { key: "professionalism", label: "专业性" },
  { key: "clarity", label: "表达清晰度" },
];

const DIFFICULTY_TONE: Record<string, "neutral" | "accent" | "danger"> = {
  基础: "neutral",
  进阶: "accent",
  挑战: "danger",
};

export function DefenseView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"prepare" | "ppt" | "mock" | "report">("prepare");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [answerDraft, setAnswerDraft] = useState("");
  const [lastScore, setLastScore] = useState<ReportScore | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [report, setReport] = useState<{
    readiness: number;
    dimensions: Array<{ name: string; score: number; comment: string }>;
    weakPoints: Array<{ area: string; issue: string; suggestion: string }>;
    summary: string;
  } | null>(null);

  const knowledgeQuery = useQuery({
    queryKey: ["defense-knowledge", projectId],
    queryFn: () =>
      apiJson<{ knowledge: Knowledge }>(`/api/projects/${projectId}/defense?resource=knowledge`),
  });
  const mainQuery = useQuery({
    queryKey: ["defense", projectId],
    queryFn: () =>
      apiJson<{ questions: QuestionItem[]; sessions: SessionItem[]; ppt: PptOutline | null }>(
        `/api/projects/${projectId}/defense`,
      ),
  });

  const questions = mainQuery.data?.questions ?? [];
  const sessions = useMemo(() => mainQuery.data?.sessions ?? [], [mainQuery.data]);
  const ppt = mainQuery.data?.ppt ?? null;
  const knowledge = knowledgeQuery.data?.knowledge ?? null;
  const activeSession = useMemo(
    () =>
      sessions.find((s) => s.id === activeSessionId) ??
      sessions.find((s) => s.status === "active") ??
      sessions[0] ??
      null,
    [sessions, activeSessionId],
  );
  const pendingTurn =
    activeSession?.turns.find((t) => !t.scores || Object.keys(t.scores).length === 0) ?? null;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["defense", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["defense-knowledge", projectId] });
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

  const genQuestions = () =>
    run("gen-q", async () => {
      const d = await apiJson<{ generated: number }>(`/api/projects/${projectId}/defense`, {
        method: "POST",
        body: JSON.stringify({ action: "generate-questions", count: 8 }),
      });
      setNotice(`已生成 ${d.generated} 个答辩问题(替换未使用的旧题)`);
    });

  const genPpt = () =>
    run("gen-ppt", async () => {
      const d = await apiJson<{ ppt: PptOutline }>(`/api/projects/${projectId}/defense`, {
        method: "POST",
        body: JSON.stringify({ action: "generate-ppt" }),
      });
      setNotice(`PPT 结构已生成(${d.ppt.slides.length} 页)`);
      setTab("ppt");
    });

  const startSession = () =>
    run("start", async () => {
      const d = await apiJson<{ session: { id: string }; turns: TurnItem[] }>(
        `/api/projects/${projectId}/defense`,
        {
          method: "POST",
          body: JSON.stringify({ action: "start-session", questionCount: 5 }),
        },
      );
      setActiveSessionId(d.session.id);
      setLastScore(null);
      setAnswerDraft("");
      setTab("mock");
    });

  const submitAnswer = () =>
    run("answer", async () => {
      if (!activeSession || !pendingTurn) return;
      const d = await apiJson<{
        scores: ReportScore;
        followupTurn: TurnItem | null;
        nextTurn: TurnItem | null;
        finished: boolean;
      }>(`/api/projects/${projectId}/defense`, {
        method: "POST",
        body: JSON.stringify({
          action: "answer",
          sessionId: activeSession.id,
          turnId: pendingTurn.id,
          answer: answerDraft.trim() || "(未作答)",
        }),
      });
      setLastScore(d.scores);
      setAnswerDraft("");
      if (d.finished) setNotice("所有题目已完成,点击「生成评估报告」查看准备度");
    });

  const finishSession = () =>
    run("finish", async () => {
      const d = await apiJson<{
        report: {
          readiness: number;
          dimensions: Array<{ name: string; score: number; comment: string }>;
          weakPoints: Array<{ area: string; issue: string; suggestion: string }>;
          summary: string;
        };
      }>(`/api/projects/${projectId}/defense`, {
        method: "POST",
        body: JSON.stringify({ action: "finish-session", sessionId: activeSession!.id }),
      });
      setReport(d.report);
      setTab("report");
    });

  if (mainQuery.isPending || knowledgeQuery.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const knowledgeReady = Boolean(knowledge && (knowledge.counts.modules ?? 0) > 0);

  return (
    <div className="space-y-5">
      {/* 知识库概览 */}
      <section className="rounded-md border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
            项目知识库
          </span>
          {knowledge?.highlights.map((h, i) => (
            <span key={i} className="text-[11px] text-zinc-500 dark:text-zinc-400">
              · {h}
            </span>
          ))}
          {knowledge && !knowledgeReady ? (
            <span className="text-[11px] text-amber-600">
              项目数据尚不完整,建议先完成需求/架构生成与开发
            </span>
          ) : null}
        </div>
      </section>

      {/* Tab 栏 */}
      <div className="flex gap-1 rounded-md border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-900/60">
        {(
          [
            {
              key: "prepare",
              label: `题库(${questions.filter((q) => q.status === "pending").length})`,
            },
            { key: "ppt", label: "PPT 结构" },
            {
              key: "mock",
              label: activeSession?.status === "active" ? "模拟答辩(进行中)" : "模拟答辩",
            },
            { key: "report", label: "评估报告" },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === key
                ? "bg-violet-600/10 text-violet-700 dark:text-violet-300"
                : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          {notice}
        </p>
      ) : null}

      {/* 题库 */}
      {tab === "prepare" ? (
        <section className="rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60">
          <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              答辩题库
            </h2>
            <span className="text-[11px] text-zinc-400">
              AI 依据项目真实技术栈与设计出题,附参考答案要点
            </span>
            <div className="ml-auto flex gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={busy !== null}
                onClick={() => void genQuestions()}
              >
                {busy === "gen-q" ? "AI 出题中…" : "AI 生成答辩问题"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={
                  busy !== null || questions.filter((q) => q.status === "pending").length === 0
                }
                onClick={() => void startSession()}
              >
                开始模拟答辩
              </Button>
            </div>
          </header>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
            {questions.length === 0 ? (
              <p className="px-4 py-10 text-center text-xs text-zinc-400">
                还没有题目。点击「AI 生成答辩问题」,AI 会读取需求/架构/数据库/代码/测试出题。
              </p>
            ) : (
              questions.map((q, i) => (
                <details key={q.id} className="group px-4 py-3">
                  <summary className="flex cursor-pointer list-none items-start gap-2.5">
                    <span className="mt-0.5 w-6 shrink-0 text-right font-mono text-[11px] text-zinc-400">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 text-sm text-zinc-800 dark:text-zinc-200">
                      {q.question}
                    </span>
                    <Badge tone="neutral">{q.category}</Badge>
                    <Badge tone={DIFFICULTY_TONE[q.difficulty] ?? "neutral"}>{q.difficulty}</Badge>
                    {q.status === "answered" ? <Badge tone="success">已练</Badge> : null}
                  </summary>
                  <div className="ml-8 mt-2 rounded-lg bg-zinc-50 p-2.5 dark:bg-zinc-800/50">
                    <p className="mb-1 text-[11px] font-semibold text-zinc-500">参考答案要点</p>
                    <ul className="list-inside list-disc space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                      {q.expectedPoints.map((p, j) => (
                        <li key={j}>{p}</li>
                      ))}
                    </ul>
                  </div>
                </details>
              ))
            )}
          </div>
        </section>
      ) : null}

      {/* PPT 结构 */}
      {tab === "ppt" ? (
        <section className="rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60">
          <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              答辩 PPT 结构
            </h2>
            <div className="ml-auto">
              <Button
                variant="primary"
                size="sm"
                disabled={busy !== null}
                onClick={() => void genPpt()}
              >
                {busy === "gen-ppt" ? "AI 设计中…" : ppt ? "重新生成" : "AI 生成 PPT 结构"}
              </Button>
            </div>
          </header>
          <div className="p-4">
            {!ppt ? (
              <p className="py-10 text-center text-xs text-zinc-400">
                还没有 PPT 结构。AI 会按「封面→背景→需求→架构→数据库→实现→测试→创新→总结」组织 10-14
                页,每页附要点、讲稿提示与配图建议。
              </p>
            ) : (
              <>
                <p className="mb-3 text-center text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  {ppt.title}
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  {ppt.slides.map((slide, i) => (
                    <div
                      key={i}
                      className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                    >
                      <p className="flex items-center gap-2 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                        <span className="flex h-5 w-5 items-center justify-center rounded bg-violet-600/10 text-[10px] text-violet-700 dark:text-violet-300">
                          {i + 1}
                        </span>
                        {slide.title}
                      </p>
                      <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                        {slide.bullets.map((b, j) => (
                          <li key={j}>{b}</li>
                        ))}
                      </ul>
                      <p className="mt-2 text-[11px] text-zinc-500">
                        <span className="font-medium">讲法:</span>
                        {slide.talkingPoints}
                      </p>
                      <p className="mt-1 text-[11px] text-violet-600 dark:text-violet-400">
                        配图建议:{slide.suggestedVisual}
                      </p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
      ) : null}

      {/* 模拟答辩 */}
      {tab === "mock" ? (
        <section className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60">
            <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                模拟答辩{activeSession ? ` · 第 ${(pendingTurn?.index ?? 0) + 1} 题` : ""}
              </h2>
              {activeSession?.status === "active" ? <Badge tone="accent">进行中</Badge> : null}
            </header>
            <div className="p-4">
              {!activeSession || activeSession.status !== "active" ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <SparklesIcon className="h-8 w-8 text-violet-400" />
                  <p className="max-w-sm text-sm text-zinc-500">
                    发起一次模拟答辩:AI
                    从题库抽取题目依次提问,每题评分并可能追问;结束后生成准备度报告。
                  </p>
                  <Button
                    variant="primary"
                    size="md"
                    disabled={
                      busy !== null || questions.filter((q) => q.status === "pending").length === 0
                    }
                    onClick={() => void startSession()}
                  >
                    {busy === "start" ? "发起中…" : "发起模拟答辩(5 题)"}
                  </Button>
                  {questions.filter((q) => q.status === "pending").length === 0 ? (
                    <p className="text-[11px] text-zinc-400">
                      题库没有待练题目,请先到「题库」生成
                    </p>
                  ) : null}
                </div>
              ) : pendingTurn ? (
                <>
                  <div className="mb-3 flex items-center gap-2">
                    <Badge tone="accent">{pendingTurn.category}</Badge>
                    {pendingTurn.isFollowup ? <Badge tone="danger">追问</Badge> : null}
                  </div>
                  <p className="mb-3 text-[15px] font-medium leading-relaxed text-zinc-900 dark:text-zinc-100">
                    {pendingTurn.question}
                  </p>
                  <textarea
                    value={answerDraft}
                    onChange={(event) => setAnswerDraft(event.target.value)}
                    placeholder="以学生身份作答…(回答你如何理解该问题、项目中如何设计与实现)"
                    rows={7}
                    className="w-full resize-y rounded-lg border border-zinc-200 bg-white p-3 text-sm outline-none focus:border-violet-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-violet-500/60"
                  />
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-[11px] text-zinc-400">{answerDraft.length} 字</span>
                    <Button
                      variant="primary"
                      size="sm"
                      className="ml-auto"
                      disabled={busy !== null}
                      onClick={() => void submitAnswer()}
                    >
                      {busy === "answer" ? "评委评分中…" : "提交回答"}
                    </Button>
                  </div>
                  {lastScore ? (
                    <div className="mt-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                      <p className="mb-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                        评委点评(上一题 · 综合{" "}
                        {typeof lastScore.overall === "number" ? lastScore.overall : "-"} 分)
                      </p>
                      <div className="mb-2 grid grid-cols-5 gap-1.5">
                        {DIMENSIONS.map(({ key, label }) => (
                          <div
                            key={String(key)}
                            className="rounded-md bg-zinc-50 px-2 py-1.5 text-center dark:bg-zinc-800/60"
                          >
                            <p className="text-[10px] text-zinc-400">{label}</p>
                            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                              {typeof lastScore[key] === "number"
                                ? (lastScore[key] as number)
                                : "-"}
                            </p>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                        {lastScore.comment}
                      </p>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="py-10 text-center text-xs text-zinc-400">
                  本会话题目已全部作答,可生成评估报告。
                </p>
              )}
            </div>
          </div>

          {/* 会话记录 */}
          <aside className="space-y-3 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
            <p className="px-1 text-xs font-semibold text-zinc-500">本次会话进度</p>
            {!activeSession ? (
              <p className="px-1 text-xs text-zinc-400">还没有会话</p>
            ) : (
              <>
                <div className="space-y-1">
                  {activeSession.turns.map((t) => {
                    const done = t.scores && Object.keys(t.scores).length > 0;
                    return (
                      <div
                        key={t.id}
                        className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-[11px]"
                      >
                        <span className={done ? "text-emerald-500" : "text-zinc-400"}>
                          {done ? "✓" : "○"}
                        </span>
                        <span className="min-w-0 flex-1 text-zinc-600 dark:text-zinc-400">
                          {t.isFollowup ? "[追问] " : ""}
                          {t.question.slice(0, 40)}
                          {t.question.length > 40 ? "…" : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {activeSession.status === "active" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full"
                    disabled={
                      busy !== null ||
                      !activeSession.turns.some((t) => t.scores && Object.keys(t.scores).length > 0)
                    }
                    onClick={() => void finishSession()}
                  >
                    {busy === "finish" ? "生成报告中…" : "结束并生成评估报告"}
                  </Button>
                ) : (
                  <p className="px-1 text-xs text-zinc-500">
                    准备度:{activeSession.overallScore ?? "-"} 分
                  </p>
                )}
              </>
            )}
            {sessions.length > 1 ? (
              <div className="border-t border-zinc-200 pt-2 dark:border-zinc-800">
                <p className="mb-1 px-1 text-[11px] font-semibold text-zinc-500">历史会话</p>
                {sessions.slice(0, 5).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setActiveSessionId(s.id);
                      setReport(null);
                    }}
                    className="block w-full rounded-lg px-2 py-1 text-left text-[11px] text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800/70"
                  >
                    {new Date(s.createdAt).toLocaleString("zh-CN", {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    ·{" "}
                    {s.status === "finished"
                      ? `准备度 ${s.overallScore}`
                      : `${s.turns.filter((t) => t.scores && Object.keys(t.scores).length > 0).length}/${s.turns.length} 已答`}
                  </button>
                ))}
              </div>
            ) : null}
          </aside>
        </section>
      ) : null}

      {/* 评估报告 */}
      {tab === "report" ? (
        <section className="rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60">
          <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              答辩准备度报告
            </h2>
          </header>
          <div className="p-4">
            {!report &&
            (!activeSession ||
              activeSession.status !== "finished" ||
              !activeSession.overallScore) ? (
              <p className="py-10 text-center text-xs text-zinc-400">
                完成一次模拟答辩后,这里会给出五维评分、答辩准备度与弱项改进建议。
              </p>
            ) : (
              <>
                <div className="mb-4 flex items-center gap-4 rounded-md bg-violet-600/5 px-4 py-3 dark:bg-violet-500/10">
                  <div className="text-center">
                    <p className="text-3xl font-bold text-violet-700 dark:text-violet-300">
                      {report?.readiness ?? activeSession?.overallScore ?? "-"}
                    </p>
                    <p className="text-[11px] text-zinc-500">答辩准备度</p>
                  </div>
                  <p className="min-w-0 flex-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                    {report?.summary ?? activeSession?.summary}
                  </p>
                </div>
                <div className="mb-4 grid gap-2 md:grid-cols-5">
                  {(report?.dimensions ?? activeSession?.dimensions ?? []).map((dim) => (
                    <div
                      key={dim.name}
                      className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800"
                    >
                      <p className="text-[11px] text-zinc-400">{dim.name}</p>
                      <p className="text-lg font-semibold text-zinc-800 dark:text-zinc-200">
                        {dim.score}
                      </p>
                      <div className="mt-1 h-1 rounded-full bg-zinc-100 dark:bg-zinc-800">
                        <div
                          className="h-1 rounded-full bg-violet-500"
                          style={{ width: `${Math.min(100, Math.max(0, dim.score))}%` }}
                        />
                      </div>
                      <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                        {dim.comment}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="mb-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                  弱项分析
                </p>
                <div className="space-y-2">
                  {(report ? report.weakPoints : (activeSession?.weakPoints ?? [])).map((w, i) => (
                    <div
                      key={i}
                      className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-500/5"
                    >
                      <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                        {w.area}
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                        {w.issue}
                      </p>
                      <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                        建议:{w.suggestion}
                      </p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
