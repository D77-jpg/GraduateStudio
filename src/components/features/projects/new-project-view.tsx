"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { apiJson } from "@/lib/api-client";
import {
  DIFFICULTIES,
  DIFFICULTY_LABELS,
  PROJECT_TYPES,
  PROJECT_TYPE_LABELS,
  SCORE_LABELS,
  projectCreateSchema,
  type Difficulty,
  type ProjectType,
  type TopicScores,
} from "@/lib/projects";
import { topicProposalOutputSchema, type TopicProposalOutput } from "@/server/ai/schemas";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { SparklesIcon } from "@/components/icons";

type Mode = "ai" | "manual";

const PREFERENCES = [
  { key: "devLanguage", label: "开发语言偏好", placeholder: "如:Java、Python、TypeScript(可选)" },
  { key: "database", label: "数据库偏好", placeholder: "如:MySQL、PostgreSQL(可选)" },
] as const;

function ScoreBars({ scores }: { scores: TopicScores }) {
  const entries = (Object.keys(SCORE_LABELS) as Array<keyof TopicScores>).map((key) => ({
    key,
    label: SCORE_LABELS[key],
    value: scores[key],
  }));
  return (
    <div className="space-y-2.5">
      {entries.map(({ key, label, value }) => (
        <div key={key} className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
            {label}
          </span>
          <Progress value={value} label={label} className="flex-1" />
          <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums text-zinc-700 dark:text-zinc-300">
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function ElapsedSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular-nums">({seconds} 秒)</span>;
}

function ProposalCard({
  proposal,
  adopting,
  onAdopt,
  onRegenerate,
}: {
  proposal: TopicProposalOutput;
  adopting: boolean;
  onAdopt: () => void;
  onRegenerate: () => void;
}) {
  return (
    <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold leading-snug text-zinc-900 dark:text-zinc-50">
            {proposal.name}
          </h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone="accent">
              {PROJECT_TYPE_LABELS[proposal.type as ProjectType] ?? proposal.type}
            </Badge>
            <Badge>
              {DIFFICULTY_LABELS[proposal.difficulty as Difficulty] ?? proposal.difficulty}
            </Badge>
            <Badge>{proposal.devLanguage}</Badge>
            <Badge>{proposal.database}</Badge>
          </div>
        </div>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
        {proposal.summary}
      </p>

      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <h4 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            项目背景
          </h4>
          <p className="mt-2 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
            {proposal.background}
          </p>
          <h4 className="mt-5 text-[13px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            项目目标
          </h4>
          <ul className="mt-2 space-y-1.5">
            {proposal.goals.map((goal) => (
              <li
                key={goal}
                className="flex gap-2 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400"
              >
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-violet-500" />
                {goal}
              </li>
            ))}
          </ul>
          <h4 className="mt-5 text-[13px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            推荐技术栈
          </h4>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {proposal.techStack.map((tech) => (
              <span
                key={tech}
                className="rounded-md border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
              >
                {tech}
              </span>
            ))}
          </div>
        </div>

        <div>
          <h4 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            AI 选题评分
          </h4>
          <div className="mt-3">
            <ScoreBars scores={proposal} />
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-5 dark:border-zinc-800">
        <Button onClick={onAdopt} disabled={adopting}>
          {adopting ? "创建中…" : "采用此方案,创建项目"}
        </Button>
        <Button variant="secondary" onClick={onRegenerate} disabled={adopting}>
          重新生成方案
        </Button>
      </div>
    </div>
  );
}

export function NewProjectView() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("ai");

  // AI 选题
  const [idea, setIdea] = useState("");
  const [prefType, setPrefType] = useState<"" | ProjectType>("");
  const [prefLanguage, setPrefLanguage] = useState("");
  const [prefDatabase, setPrefDatabase] = useState("");
  const [prefDifficulty, setPrefDifficulty] = useState<"" | Difficulty>("");
  const [needsAi, setNeedsAi] = useState(false);
  const [proposal, setProposal] = useState<TopicProposalOutput | null>(null);
  const [topicPending, setTopicPending] = useState(false);
  const [topicError, setTopicError] = useState<string | null>(null);
  const [adoptPending, setAdoptPending] = useState(false);

  // 手动创建
  const [manualName, setManualName] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [manualType, setManualType] = useState<ProjectType>("web");
  const [manualTechStack, setManualTechStack] = useState("");
  const [manualLanguage, setManualLanguage] = useState("");
  const [manualDatabase, setManualDatabase] = useState("");
  const [manualDifficulty, setManualDifficulty] = useState<"" | Difficulty>("medium");
  const [manualNeedsAi, setManualNeedsAi] = useState(false);
  const [manualPending, setManualPending] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  async function runTopic() {
    setTopicPending(true);
    setTopicError(null);
    setProposal(null);
    try {
      const data = await apiJson<{ proposal: unknown }>("/api/projects/topic", {
        method: "POST",
        body: JSON.stringify({
          idea,
          ...(prefType ? { type: prefType } : {}),
          ...(prefLanguage ? { devLanguage: prefLanguage } : {}),
          ...(prefDatabase ? { database: prefDatabase } : {}),
          ...(prefDifficulty ? { difficulty: prefDifficulty } : {}),
          needsAi,
        }),
      });
      setProposal(topicProposalOutputSchema.parse(data.proposal));
    } catch (error) {
      setTopicError(error instanceof Error ? error.message : "生成失败,请重试");
    } finally {
      setTopicPending(false);
    }
  }

  async function adoptProposal() {
    if (!proposal) return;
    setAdoptPending(true);
    try {
      const data = await apiJson<{ project: { id: string } }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name: proposal.name,
          description: proposal.summary,
          type: proposal.type,
          techStack: proposal.techStack,
          devLanguage: proposal.devLanguage,
          database: proposal.database,
          difficulty: proposal.difficulty,
          needsAi,
          background: proposal.background,
          goals: proposal.goals,
          scores: {
            innovation: proposal.innovation,
            implementDifficulty: proposal.implementDifficulty,
            paperFriendliness: proposal.paperFriendliness,
            defense: proposal.defense,
            overall: proposal.overall,
          },
        }),
      });
      router.push(`/projects/${data.project.id}/requirements`);
    } catch (error) {
      setTopicError(error instanceof Error ? error.message : "创建失败,请重试");
      setAdoptPending(false);
    }
  }

  async function submitManual() {
    setManualPending(true);
    setManualError(null);
    try {
      const payload = projectCreateSchema.parse({
        name: manualName,
        description: manualDescription,
        type: manualType,
        techStack: manualTechStack
          .split(/[,，、]/)
          .map((item) => item.trim())
          .filter(Boolean),
        devLanguage: manualLanguage,
        database: manualDatabase,
        difficulty: manualDifficulty || undefined,
        needsAi: manualNeedsAi,
      });
      const data = await apiJson<{ project: { id: string } }>("/api/projects", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      router.push(`/projects/${data.project.id}/requirements`);
    } catch (error) {
      setManualError(
        error instanceof z.ZodError
          ? (error.issues[0]?.message ?? "请检查表单填写")
          : error instanceof Error
            ? error.message
            : "创建失败,请重试",
      );
      setManualPending(false);
    }
  }

  const canGenerate = idea.trim().length >= 5 && !topicPending;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex gap-1 rounded-md border border-zinc-200 p-1 dark:border-zinc-800">
        {(
          [
            { key: "ai", label: "AI 选题(推荐)" },
            { key: "manual", label: "手动创建" },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              mode === key
                ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
                : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "ai" ? (
        <div className="mt-6">
          <Field
            label="描述你的毕业设计想法"
            hint="越具体越好:领域、方向、你感兴趣的技术都可以写。"
          >
            <Textarea
              rows={3}
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              placeholder="例:我想做一个校园二手交易系统…"
            />
          </Field>

          <details className="mt-4 rounded-md border border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <summary className="cursor-pointer text-sm font-medium text-zinc-600 dark:text-zinc-300">
              选题偏好（可选，未填写的内容由 AI 推荐）
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="项目类型">
                <Select
                  value={prefType}
                  onChange={(e) => setPrefType(e.target.value as ProjectType | "")}
                >
                  <option value="">由 AI 推荐</option>
                  {PROJECT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {PROJECT_TYPE_LABELS[type]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="难度">
                <Select
                  value={prefDifficulty}
                  onChange={(e) => setPrefDifficulty(e.target.value as Difficulty | "")}
                >
                  <option value="">由 AI 推荐</option>
                  {DIFFICULTIES.map((difficulty) => (
                    <option key={difficulty} value={difficulty}>
                      {DIFFICULTY_LABELS[difficulty]}
                    </option>
                  ))}
                </Select>
              </Field>
              {PREFERENCES.map(({ key, label, placeholder }) => (
                <Field key={key} label={label}>
                  <Input
                    value={key === "devLanguage" ? prefLanguage : prefDatabase}
                    onChange={(e) =>
                      key === "devLanguage"
                        ? setPrefLanguage(e.target.value)
                        : setPrefDatabase(e.target.value)
                    }
                    placeholder={placeholder}
                  />
                </Field>
              ))}
              <label className="flex items-center gap-2.5 self-end pb-2 text-sm text-zinc-700 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={needsAi}
                  onChange={(e) => setNeedsAi(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300 accent-violet-600"
                />
                项目需要包含 AI 能力
              </label>
            </div>
          </details>

          <div className="mt-5 flex items-center gap-3">
            <Button size="lg" onClick={runTopic} disabled={!canGenerate}>
              <SparklesIcon className="h-4 w-4" />
              {topicPending ? "AI 正在生成选题方案" : "生成选题方案"}
              {topicPending ? <ElapsedSeconds /> : null}
            </Button>
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              通常需要 10-30 秒
            </span>
          </div>

          {topicError ? (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50/60 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/5 dark:text-red-400">
              {topicError}
              <a href="/settings" className="ml-2 underline underline-offset-4">
                查看 AI 服务状态
              </a>
            </div>
          ) : null}

          {topicPending ? (
            <div className="mt-6 animate-pulse rounded-2xl border border-zinc-200 p-6 dark:border-zinc-800">
              <div className="h-5 w-2/3 rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="mt-3 h-4 w-full rounded bg-zinc-100 dark:bg-zinc-800/60" />
              <div className="mt-2 h-4 w-5/6 rounded bg-zinc-100 dark:bg-zinc-800/60" />
            </div>
          ) : null}

          {proposal ? (
            <ProposalCard
              proposal={proposal}
              adopting={adoptPending}
              onAdopt={adoptProposal}
              onRegenerate={runTopic}
            />
          ) : null}
        </div>
      ) : (
        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submitManual();
          }}
        >
          <Field label="项目名称">
            <Input
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              placeholder="如:基于 Spring Boot 的校园二手交易平台设计与实现"
              required
              minLength={2}
              maxLength={80}
            />
          </Field>
          <Field label="项目描述">
            <Textarea
              rows={3}
              value={manualDescription}
              onChange={(e) => setManualDescription(e.target.value)}
              placeholder="一两句话描述项目要做什么(可选)"
              maxLength={500}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="项目类型">
              <Select
                value={manualType}
                onChange={(e) => setManualType(e.target.value as ProjectType)}
              >
                {PROJECT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {PROJECT_TYPE_LABELS[type]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="难度">
              <Select
                value={manualDifficulty}
                onChange={(e) => setManualDifficulty(e.target.value as Difficulty | "")}
              >
                <option value="">未定</option>
                {DIFFICULTIES.map((difficulty) => (
                  <option key={difficulty} value={difficulty}>
                    {DIFFICULTY_LABELS[difficulty]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="开发语言">
              <Input
                value={manualLanguage}
                onChange={(e) => setManualLanguage(e.target.value)}
                placeholder="如:Java(可选)"
              />
            </Field>
            <Field label="数据库偏好">
              <Input
                value={manualDatabase}
                onChange={(e) => setManualDatabase(e.target.value)}
                placeholder="如:MySQL(可选)"
              />
            </Field>
            <Field label="技术栈偏好" hint="多个技术用逗号分隔,如:Vue 3, Spring Boot, MySQL">
              <Input
                value={manualTechStack}
                onChange={(e) => setManualTechStack(e.target.value)}
                placeholder="如:Vue 3, Spring Boot, MySQL"
              />
            </Field>
            <label className="flex items-center gap-2.5 self-end pb-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={manualNeedsAi}
                onChange={(e) => setManualNeedsAi(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 accent-violet-600"
              />
              项目需要包含 AI 能力
            </label>
          </div>

          {manualError ? (
            <div className="rounded-md border border-red-200 bg-red-50/60 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/5 dark:text-red-400">
              {manualError}
            </div>
          ) : null}

          <Button type="submit" size="lg" disabled={manualPending}>
            {manualPending ? "创建中…" : "创建项目"}
          </Button>
        </form>
      )}
    </div>
  );
}
