import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { formatRelativeTime } from "@/lib/format";
import {
  PROJECT_TYPE_LABELS,
  STAGE_LABELS,
  type ProjectDto,
  type ProjectType,
} from "@/lib/projects";

export function TechStackChips({ items, max = 4 }: { items: string[]; max?: number }) {
  if (items.length === 0) return null;
  const visible = items.slice(0, max);
  const rest = items.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible.map((tech) => (
        <span
          key={tech}
          className="rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
        >
          {tech}
        </span>
      ))}
      {rest > 0 ? (
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">+{rest}</span>
      ) : null}
    </div>
  );
}

export function ProjectCard({ project }: { project: ProjectDto }) {
  const typeLabel =
    PROJECT_TYPE_LABELS[project.type as ProjectType] ?? project.type;

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group flex flex-col rounded-2xl border border-zinc-200 p-5 transition-all hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:hover:border-zinc-700"
    >
      <div className="flex items-center justify-between gap-2">
        <Badge>{typeLabel}</Badge>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">
          {formatRelativeTime(project.updatedAt)}
        </span>
      </div>

      <h3 className="mt-3 font-medium leading-snug text-zinc-900 dark:text-zinc-100">
        {project.name}
      </h3>
      {project.description ? (
        <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
          {project.description}
        </p>
      ) : null}

      <div className="mt-3.5">
        <TechStackChips items={project.techStack} max={3} />
      </div>

      <div className="mt-auto pt-4">
        <Progress value={project.progress} label={`${project.name} 完成度`} />
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-zinc-500 dark:text-zinc-400">
            {STAGE_LABELS[project.stage]}
          </span>
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {project.progress}%
          </span>
        </div>
      </div>
    </Link>
  );
}
