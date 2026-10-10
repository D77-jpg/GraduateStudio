"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Button, ButtonLink } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PlusIcon, SparklesIcon } from "@/components/icons";
import { projectDtoSchema } from "@/lib/projects";
import { FeaturedProject } from "./featured-project";
import { ProjectCard } from "./project-card";

async function fetchProjects() {
  const res = await fetch("/api/projects");
  if (!res.ok) {
    const message =
      res.status === 401 ? "登录状态已失效,请重新登录" : `项目数据加载失败(${res.status})`;
    throw new Error(message);
  }
  const json: unknown = await res.json();
  return z.object({ projects: z.array(projectDtoSchema) }).parse(json).projects;
}

function ProjectsSkeleton() {
  return (
    <div aria-busy>
      <Skeleton className="h-44 rounded-2xl" />
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-44 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50/60 p-10 text-center dark:border-red-500/30 dark:bg-red-500/5">
      <p className="font-medium text-red-700 dark:text-red-400">项目数据加载失败</p>
      <p className="mt-1 text-sm text-red-600/80 dark:text-red-400/70">
        请检查网络或稍后重试;若持续失败,请查看服务端日志。
      </p>
      <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

function EmptyProjects() {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-300 p-12 text-center dark:border-zinc-700">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-violet-600/10 text-violet-600 dark:text-violet-400">
        <SparklesIcon />
      </span>
      <p className="mt-4 font-medium text-zinc-900 dark:text-zinc-100">
        从零开始你的毕业设计
      </p>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
        创建第一个项目后,AI 将协助你完成选题、需求分析、开发、测试、论文与答辩。
      </p>
      <ButtonLink href="/projects/new" size="md" className="mt-5">
        <PlusIcon className="h-4 w-4" />
        创建项目
      </ButtonLink>
    </div>
  );
}

export function ProjectsView() {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["projects"],
    queryFn: fetchProjects,
  });

  if (isPending) return <ProjectsSkeleton />;
  if (isError) return <ErrorState onRetry={() => void refetch()} />;
  if (data.length === 0) return <EmptyProjects />;

  const [featured, ...rest] = data;

  return (
    <div className="space-y-8">
      <FeaturedProject project={featured} />

      {rest.length > 0 ? (
        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              最近项目
            </h2>
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              共 {data.length} 个项目
            </span>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
