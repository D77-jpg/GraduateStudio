import Link from "next/link";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";

/**
 * 项目子页面统一导航条:「← 返回项目」+ 面包屑(工作台 / 项目名 / 当前页)。
 * 放在每个子页面内容的最顶部,保证任何层级都能一键回到项目详情。
 */
export function SubPageNav({
  projectId,
  projectName,
  current,
}: {
  projectId: string;
  projectName: string;
  current: string;
}) {
  return (
    <div className="flex items-center gap-1.5 border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
      <Link
        href={`/projects/${projectId}`}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <ChevronLeftIcon className="h-3.5 w-3.5" />
        返回项目
      </Link>
      <ChevronRightIcon className="h-3 w-3 text-zinc-300 dark:text-zinc-600" />
      <Link
        href={`/projects/${projectId}`}
        className="max-w-56 truncate hover:text-zinc-900 dark:hover:text-zinc-200"
      >
        {projectName}
      </Link>
      <ChevronRightIcon className="h-3 w-3 text-zinc-300 dark:text-zinc-600" />
      <span className="text-zinc-700 dark:text-zinc-300">{current}</span>
    </div>
  );
}
