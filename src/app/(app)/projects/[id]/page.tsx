import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/server/auth";
import { getProjectById } from "@/server/projects";
import { SetPageTitle } from "@/components/layout/topbar";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ButtonLink } from "@/components/ui/button";
import { CheckIcon, ChevronRightIcon } from "@/components/icons";
import { formatDate, formatRelativeTime } from "@/lib/format";
import {
  DIFFICULTY_LABELS,
  PROJECT_STAGES,
  PROJECT_STATUS_LABELS,
  PROJECT_TYPE_LABELS,
  SCORE_LABELS,
  STAGE_LABELS,
  stageIndex,
  type Difficulty,
  type ProjectStage,
  type ProjectStatus,
  type ProjectType,
  type TopicScores,
} from "@/lib/projects";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) notFound();

  const project = await getProjectById(id, session.user.id);
  if (!project) notFound();

  const current = stageIndex(project.stage);
  const requirementStarted = current >= stageIndex("requirements");

  return (
    <>
      <SetPageTitle title={project.name} />
      <div className="w-full px-4 py-8 lg:px-10">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          <ChevronRightIcon className="h-4 w-4 rotate-180" />
          返回工作台
        </Link>

        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>
                {PROJECT_TYPE_LABELS[project.type as ProjectType] ?? project.type}
              </Badge>
              <Badge tone={project.status === "completed" ? "success" : "neutral"}>
                {PROJECT_STATUS_LABELS[project.status as ProjectStatus] ?? project.status}
              </Badge>
              {project.difficulty ? (
                <Badge>
                  {DIFFICULTY_LABELS[project.difficulty as Difficulty] ?? project.difficulty}
                </Badge>
              ) : null}
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              {project.name}
            </h1>
            {project.description ? (
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                {project.description}
              </p>
            ) : null}
            <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">
              {formatRelativeTime(project.updatedAt)}更新 · 创建于 {formatDate(project.createdAt)}
            </p>
          </div>

          <div className="shrink-0 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800 lg:w-64">
            <p className="text-3xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
              {project.progress}
              <span className="ml-0.5 text-base font-normal text-zinc-400">%</span>
            </p>
            <Progress value={project.progress} label="毕业设计完成度" className="mt-3" />
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              阶段 {current + 1}/{PROJECT_STAGES.length} · {STAGE_LABELS[project.stage]}
            </p>
          </div>
        </div>

        <section className="mt-10">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            毕业进度
          </h2>
          <ol className="mt-3 flex flex-wrap gap-2">
            {PROJECT_STAGES.map((stage: ProjectStage, index: number) => {
              const done = index < current;
              const active = index === current;
              return (
                <li key={stage}>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
                      active
                        ? "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300"
                        : done
                          ? "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400"
                          : "border-zinc-200/70 text-zinc-300 dark:border-zinc-800 dark:text-zinc-600"
                    }`}
                  >
                    {done ? <CheckIcon className="h-3.5 w-3.5" /> : null}
                    {STAGE_LABELS[stage]}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        {project.scores ? (
          <section className="mt-8">
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              AI 选题评分
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {(Object.keys(SCORE_LABELS) as Array<keyof TopicScores>).map((key) => (
                <span
                  key={key}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${
                    key === "overall"
                      ? "border-violet-300 bg-violet-50 font-semibold text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300"
                      : "border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
                  }`}
                >
                  {SCORE_LABELS[key]} {project.scores![key]}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {project.background ? (
          <section className="mt-8">
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              项目背景
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
              {project.background}
            </p>
          </section>
        ) : null}

        {project.goals.length > 0 ? (
          <section className="mt-8">
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              项目目标
            </h2>
            <ul className="mt-2 max-w-3xl space-y-1.5">
              {project.goals.map((goal) => (
                <li
                  key={goal}
                  className="flex gap-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300"
                >
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-violet-500" />
                  {goal}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {project.techStack.length > 0 ? (
          <section className="mt-8">
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              技术栈
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {project.techStack.map((tech) => (
                <span
                  key={tech}
                  className="rounded-lg border border-zinc-200 px-2.5 py-1 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
                >
                  {tech}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        <div className="mt-10 flex flex-wrap items-center gap-3">
          <ButtonLink
            href={`/projects/${project.id}/develop`}
            variant={current >= stageIndex("coding") ? "primary" : "secondary"}
            size="md"
          >
            开发工作区
            <ChevronRightIcon className="h-4 w-4" />
          </ButtonLink>
          <ButtonLink
            href={`/projects/${project.id}/run`}
            variant="secondary"
            size="md"
          >
            运行与预览
            <ChevronRightIcon className="h-4 w-4" />
          </ButtonLink>
          <ButtonLink
            href={`/projects/${project.id}/agent`}
            variant="secondary"
            size="md"
          >
            自主开发(Agent)
            <ChevronRightIcon className="h-4 w-4" />
          </ButtonLink>
          <ButtonLink
            href={`/projects/${project.id}/tests`}
            variant="secondary"
            size="md"
          >
            测试中心
            <ChevronRightIcon className="h-4 w-4" />
          </ButtonLink>
          <ButtonLink
            href={`/projects/${project.id}/git`}
            variant="secondary"
            size="md"
          >
            版本控制
            <ChevronRightIcon className="h-4 w-4" />
          </ButtonLink>
          <ButtonLink
            href={`/projects/${project.id}/docs`}
            variant="secondary"
            size="md"
          >
            毕设文档
            <ChevronRightIcon className="h-4 w-4" />
          </ButtonLink>
          <ButtonLink
            href={`/projects/${project.id}/defense`}
            variant="secondary"
            size="md"
          >
            答辩中心
            <ChevronRightIcon className="h-4 w-4" />
          </ButtonLink>
          <ButtonLink
            href={`/projects/${project.id}/deploy`}
            variant="secondary"
            size="md"
          >
            部署中心
            <ChevronRightIcon className="h-4 w-4" />
          </ButtonLink>
          <ButtonLink
            href={`/projects/${project.id}/requirements`}
            variant={requirementStarted ? "secondary" : "primary"}
            size="md"
          >
            {requirementStarted ? "查看需求分析" : "开始需求分析"}
            <ChevronRightIcon className="h-4 w-4" />
          </ButtonLink>
          <ButtonLink
            href={`/projects/${project.id}/architecture`}
            variant={current >= stageIndex("architecture") ? "secondary" : "primary"}
            size="md"
          >
            {current >= stageIndex("architecture") ? "查看系统架构" : "AI 设计系统架构"}
            <ChevronRightIcon className="h-4 w-4" />
          </ButtonLink>
          <ButtonLink href="/settings" variant="ghost" size="md">
            打开设置
          </ButtonLink>
        </div>
      </div>
    </>
  );
}
