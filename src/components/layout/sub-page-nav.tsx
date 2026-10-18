"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import {
  PROJECT_STAGES,
  PROJECT_TOOLS,
  STAGE_LABELS,
  STAGE_METADATA,
  projectRoute,
  stageFromPath,
  stageRoute,
} from "@/lib/projects";

type SubPageNavProps = { projectId: string; projectName: string; current: string };

/** 保留统一返回入口，并让每个工作区都能直接切换完整产品阶段。 */
export function SubPageNav(props: SubPageNavProps) {
  return (
    <Suspense
      fallback={
        <div className="h-28 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
      }
    >
      <ProjectNavigation {...props} />
    </Suspense>
  );
}

function ProjectNavigation({ projectId, projectName, current }: SubPageNavProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = stageFromPath(projectId, pathname, searchParams.get("stage") === "design");
  const activeTool = PROJECT_TOOLS.find((tool) => pathname === projectRoute(projectId, tool.path));
  const currentLabel = active ? STAGE_LABELS[active] : (activeTool?.label ?? current);

  return (
    <div className="border-b border-zinc-200/80 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex min-w-0 items-center gap-2 px-4 py-3 text-xs text-zinc-500 sm:px-6 dark:text-zinc-400">
        <Link
          href={projectRoute(projectId)}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 font-medium transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-[#0071e3] dark:hover:bg-zinc-800 dark:hover:text-white"
        >
          <ChevronLeftIcon className="h-3.5 w-3.5" />
          返回项目
        </Link>
        <ChevronRightIcon className="h-3 w-3 shrink-0 text-zinc-300" />
        <Link href={projectRoute(projectId)} className="max-w-56 truncate hover:text-[#0071e3]">
          {projectName}
        </Link>
        <ChevronRightIcon className="h-3 w-3 shrink-0 text-zinc-300" />
        <span className="shrink-0 font-medium text-zinc-800 dark:text-zinc-200">
          {currentLabel}
        </span>
      </div>
      <nav aria-label="毕业设计阶段" className="overflow-x-auto px-4 sm:px-6">
        <ol className="flex min-w-max gap-1 pb-3">
          {PROJECT_STAGES.map((stage, index) => (
            <li key={stage}>
              <Link
                href={stageRoute(projectId, stage)}
                prefetch={true}
                aria-current={active === stage ? "page" : undefined}
                title={STAGE_METADATA[stage].description}
                className={`inline-flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[#0071e3] ${active === stage ? "bg-[#0071e3] text-white shadow-sm" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"}`}
              >
                <span className={active === stage ? "text-white/70" : "text-zinc-400"}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                {STAGE_LABELS[stage]}
              </Link>
            </li>
          ))}
        </ol>
      </nav>
      <nav
        aria-label="项目辅助工具"
        className="flex flex-wrap items-center gap-1 border-t border-zinc-100 px-4 py-2 text-xs sm:px-6 dark:border-zinc-800"
      >
        <span className="mr-2 text-zinc-400">项目工具</span>
        {PROJECT_TOOLS.map((tool) => (
          <Link
            key={tool.key}
            href={projectRoute(projectId, tool.path)}
            prefetch={true}
            aria-current={activeTool?.key === tool.key ? "page" : undefined}
            className={`rounded-lg px-2.5 py-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-[#0071e3] ${activeTool?.key === tool.key ? "bg-blue-50 font-medium text-[#0071e3] dark:bg-blue-500/10 dark:text-blue-400" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white"}`}
          >
            {tool.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
