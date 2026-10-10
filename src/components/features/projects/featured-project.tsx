import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ChevronRightIcon } from "@/components/icons";
import { TechStackChips } from "./project-card";
import { formatRelativeTime } from "@/lib/format";
import { STAGE_LABELS, STAGE_METADATA, stageRoute, type ProjectDto } from "@/lib/projects";

/** 「继续开发」主卡:最近更新的项目,提供快速回到开发的入口。 */
export function FeaturedProject({ project }: { project: ProjectDto }) {
  return (
    <section>
      <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        继续开发
      </h2>
      <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold leading-snug text-zinc-900 dark:text-zinc-50">
              {project.name}
            </h3>
            {project.description ? (
              <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                {project.description}
              </p>
            ) : null}

            <div className="mt-4">
              <TechStackChips items={project.techStack} />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-zinc-500 dark:text-zinc-400">
              <span className="flex items-center gap-1.5">
                当前阶段
                <Badge tone="accent">{STAGE_LABELS[project.stage]}</Badge>
              </span>
              <span className="text-xs">{formatRelativeTime(project.updatedAt)}更新</span>
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
            <div className="text-right">
              <p className="text-3xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
                {project.progress}
                <span className="ml-0.5 text-base font-normal text-zinc-400">%</span>
              </p>
              <Progress
                value={project.progress}
                label={`${project.name} 完成度`}
                className="mt-2 w-36"
              />
            </div>
            <p className="max-w-64 text-xs leading-5 text-zinc-500 sm:text-right">
              {STAGE_METADATA[project.stage].description}
            </p>
            <ButtonLink
              href={stageRoute(project.id, project.stage)}
              size="md"
              className="!bg-[#0071e3] !text-white hover:!bg-[#0064c9]"
            >
              继续{STAGE_LABELS[project.stage]}
              <ChevronRightIcon className="h-4 w-4" />
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}
