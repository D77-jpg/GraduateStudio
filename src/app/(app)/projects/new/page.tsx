import Link from "next/link";
import { SetPageTitle } from "@/components/layout/topbar";
import { NewProjectView } from "@/components/features/projects/new-project-view";
import { ChevronRightIcon } from "@/components/icons";

export default function NewProjectPage() {
  return (
    <>
      <SetPageTitle title="新建项目" />
      <div className="w-full px-4 py-8 lg:px-10">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          <ChevronRightIcon className="h-4 w-4 rotate-180" />
          返回工作台
        </Link>

        <div className="mx-auto mt-6 max-w-2xl text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            创建你的毕业设计
          </h1>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
            用一句话描述想法,让 AI 给出完整选题方案;或者直接填写已知信息手动创建。
          </p>
        </div>

        <div className="mt-8">
          <NewProjectView />
        </div>
      </div>
    </>
  );
}
