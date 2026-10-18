import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/server/auth";
import { getProjectById } from "@/server/projects";
import { SetPageTitle } from "@/components/layout/topbar";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { CheckIcon, ChevronRightIcon } from "@/components/icons";
import { formatDate, formatRelativeTime } from "@/lib/format";
import {
  DIFFICULTY_LABELS,
  PROJECT_STAGES,
  PROJECT_STATUS_LABELS,
  PROJECT_TYPE_LABELS,
  PROJECT_TOOLS,
  SCORE_LABELS,
  STAGE_METADATA,
  stageIndex,
  stageRoute,
  projectRoute,
  type Difficulty,
  type ProjectStatus,
  type ProjectType,
  type TopicScores,
} from "@/lib/projects";

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) notFound();
  const project = await getProjectById(id, session.user.id);
  if (!project) notFound();
  const current = stageIndex(project.stage);
  const currentStage = STAGE_METADATA[project.stage];

  return (
    <>
      <SetPageTitle title={project.name} />
      <div className="min-h-full bg-[#f5f5f7] px-4 py-8 sm:px-6 lg:px-10 lg:py-10 dark:bg-zinc-950">
        <div className="mx-auto max-w-7xl">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-[#0071e3] focus-visible:outline-2 focus-visible:outline-[#0071e3]"
          >
            <ChevronRightIcon className="h-4 w-4 rotate-180" />
            返回工作台
          </Link>

          <header className="mt-6 grid gap-8 rounded-3xl border border-white bg-white p-6 shadow-sm sm:p-8 lg:grid-cols-[1fr_320px] lg:p-10 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="min-w-0">
              <p className="text-xs font-semibold tracking-[0.18em] text-[#0071e3] dark:text-blue-400">
                PROJECT OVERVIEW / 项目概览
              </p>
              <h1 className="mt-4 break-words text-3xl font-semibold tracking-tight text-zinc-900 sm:text-4xl lg:text-5xl lg:leading-tight dark:text-zinc-50">
                {project.name}
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-500 dark:text-zinc-400">
                {project.description || "将一个想法，逐步打磨成可以展示、交付与答辩的毕业设计。"}
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <Badge>{PROJECT_TYPE_LABELS[project.type as ProjectType] ?? project.type}</Badge>
                <Badge tone={project.status === "completed" ? "success" : "neutral"}>
                  {PROJECT_STATUS_LABELS[project.status as ProjectStatus] ?? project.status}
                </Badge>
                {project.difficulty ? (
                  <Badge>
                    {DIFFICULTY_LABELS[project.difficulty as Difficulty] ?? project.difficulty}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-5 text-xs text-zinc-400">
                {formatRelativeTime(project.updatedAt)}更新 · 创建于 {formatDate(project.createdAt)}
              </p>
            </div>
            <div className="flex flex-col justify-between rounded-2xl bg-[#f5f5f7] p-6 dark:bg-zinc-950">
              <div>
                <div className="flex items-center justify-between text-xs text-zinc-500">
                  <span>毕业设计完成度</span>
                  <span>
                    阶段 {current + 1} / {PROJECT_STAGES.length}
                  </span>
                </div>
                <p className="mt-3 text-5xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-white">
                  {project.progress}
                  <span className="ml-1 text-xl font-normal text-zinc-400">%</span>
                </p>
                <Progress value={project.progress} label="毕业设计完成度" className="mt-4" />
                <p className="mt-5 text-sm font-semibold text-zinc-900 dark:text-white">
                  当前阶段 · {currentStage.label}
                </p>
                <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                  {currentStage.description}
                </p>
              </div>
              <Link
                href={stageRoute(project.id, project.stage)}
                className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#0071e3] px-5 text-sm font-medium text-white transition-colors hover:bg-[#0064c9] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0071e3]"
              >
                继续{currentStage.label}
                <ChevronRightIcon className="h-4 w-4" />
              </Link>
            </div>
          </header>

          <section
            aria-labelledby="full-project-generation"
            className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-blue-100 bg-blue-50/70 p-6 dark:border-blue-500/20 dark:bg-blue-500/10"
          >
            <div>
              <h2
                id="full-project-generation"
                className="text-base font-semibold text-zinc-900 dark:text-white"
              >
                生成完整项目
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                基于已确认需求自动规划模块、生成代码并进行构建与测试，无需逐轮输入提示词。执行有预算上限，结果需人工验收。
              </p>
            </div>
            <Link
              href={`/projects/${project.id}/agent`}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-[#0071e3] px-5 text-sm font-medium text-white transition-colors hover:bg-[#0064c9] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0071e3]"
            >
              生成完整项目
              <ChevronRightIcon className="h-4 w-4" />
            </Link>
          </section>

          <section aria-labelledby="project-stages" className="mt-10">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs font-medium tracking-wider text-zinc-400">从想法到答辩</p>
                <h2
                  id="project-stages"
                  className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-white"
                >
                  毕业设计路径
                </h2>
              </div>
              <p className="text-sm text-zinc-500">10 个阶段，随时进入所需工作区</p>
            </div>
            <ol className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {PROJECT_STAGES.map((stage, index) => {
                const active = index === current;
                const earlier = index < current;
                return (
                  <li key={stage}>
                    <Link
                      href={stageRoute(project.id, stage)}
                      aria-current={active ? "step" : undefined}
                      className={`group flex h-full min-h-44 flex-col rounded-2xl border p-5 transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0071e3] ${active ? "border-[#0071e3] bg-blue-50/70 dark:bg-blue-500/10" : "border-zinc-200/70 bg-white hover:border-blue-200 dark:border-zinc-800 dark:bg-zinc-900"}`}
                    >
                      <div className="flex items-center justify-between">
                        <span
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold ${active ? "bg-[#0071e3] text-white" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"}`}
                        >
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        {active ? (
                          <span className="text-xs font-medium text-[#0071e3] dark:text-blue-400">
                            当前阶段
                          </span>
                        ) : earlier ? (
                          <CheckIcon className="h-4 w-4 text-zinc-400" aria-label="此前阶段" />
                        ) : (
                          <ChevronRightIcon className="h-4 w-4 text-zinc-300 group-hover:text-[#0071e3]" />
                        )}
                      </div>
                      <h3 className="mt-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {STAGE_METADATA[stage].label}
                      </h3>
                      <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                        {STAGE_METADATA[stage].description}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>

          <section
            aria-labelledby="project-tools"
            className="mt-10 rounded-3xl border border-zinc-200/70 bg-white p-6 sm:p-8 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <h2
              id="project-tools"
              className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white"
            >
              项目工具
            </h2>
            <p className="mt-2 text-sm text-zinc-500">
              贯穿开发过程的辅助能力，不额外增加毕业设计阶段。
            </p>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              {PROJECT_TOOLS.map((tool) => (
                <Link
                  key={tool.key}
                  href={projectRoute(project.id, tool.path)}
                  className="group rounded-2xl bg-[#f5f5f7] p-5 transition-colors hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-[#0071e3] dark:bg-zinc-950 dark:hover:bg-blue-500/10"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
                      {tool.label}
                    </h3>
                    <ChevronRightIcon className="h-4 w-4 text-zinc-400 group-hover:text-[#0071e3]" />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-zinc-500">{tool.description}</p>
                </Link>
              ))}
            </div>
          </section>

          <section aria-labelledby="project-context" className="mt-6 grid gap-6 lg:grid-cols-2">
            <div className="rounded-3xl border border-zinc-200/70 bg-white p-6 sm:p-8 dark:border-zinc-800 dark:bg-zinc-900">
              <h2
                id="project-context"
                className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white"
              >
                项目规划
              </h2>
              <h3 className="mt-5 text-xs font-semibold text-zinc-400">项目背景</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-zinc-600 dark:text-zinc-300">
                {project.background || "尚未补充项目背景，可在选题规划与需求分析中逐步明确。"}
              </p>
              <h3 className="mt-5 text-xs font-semibold text-zinc-400">项目目标</h3>
              {project.goals.length ? (
                <ul className="mt-3 space-y-2">
                  {project.goals.map((goal, index) => (
                    <li
                      key={`${index}-${goal}`}
                      className="flex gap-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300"
                    >
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#0071e3]" />
                      {goal}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-zinc-500">
                  完成需求分析，形成清晰的功能目标与交付范围。
                </p>
              )}
            </div>
            <div className="rounded-3xl border border-zinc-200/70 bg-white p-6 sm:p-8 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white">
                技术与评估
              </h2>
              <h3 className="mt-5 text-xs font-semibold text-zinc-400">技术栈</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {project.techStack.length ? (
                  project.techStack.map((tech) => (
                    <span
                      key={tech}
                      className="rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                    >
                      {tech}
                    </span>
                  ))
                ) : (
                  <p className="text-sm text-zinc-500">在架构设计阶段确定适合项目的技术方案。</p>
                )}
              </div>
              {project.scores ? (
                <>
                  <h3 className="mt-6 text-xs font-semibold text-zinc-400">AI 选题评分</h3>
                  <dl className="mt-3 grid grid-cols-2 gap-3">
                    {(Object.keys(SCORE_LABELS) as Array<keyof TopicScores>).map((key) => (
                      <div
                        key={key}
                        className={`flex items-center justify-between rounded-xl px-3 py-3 ${key === "overall" ? "bg-blue-50 text-[#0071e3] dark:bg-blue-500/10 dark:text-blue-400" : "bg-zinc-50 text-zinc-600 dark:bg-zinc-950 dark:text-zinc-300"}`}
                      >
                        <dt className="text-xs">{SCORE_LABELS[key]}</dt>
                        <dd className="text-lg font-semibold tabular-nums">
                          {project.scores![key]}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
