import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { getProjectById } from "@/server/projects";
import { ErDiagram } from "@/components/features/architecture/er-diagram";
import { PageHeader, SetPageTitle } from "@/components/layout/topbar";
import { SubPageNav } from "@/components/layout/sub-page-nav";
import { ChevronRightIcon } from "@/components/icons";

export default async function DatabasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const project = await getProjectById(id, session.user.id);
  if (!project) notFound();

  return (
    <>
      <SetPageTitle title={`数据库设计 · ${project.name}`} />
      <SubPageNav projectId={project.id} projectName={project.name} current="数据库设计" />
      <div className="w-full px-4 py-8 lg:px-10">
        <Link
          href={`/projects/${project.id}/architecture`}
          className="inline-flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          <ChevronRightIcon className="h-4 w-4 rotate-180" />
          返回系统架构
        </Link>
        <div className="mt-4">
          <PageHeader
            title="数据库 ER 图"
            description="把数据库设计画成 Chen 概念模型,可缩放、平移并导出图片,下方查看表字段与关系。"
          />
        </div>
        <div className="mt-8">
          <ErDiagram projectId={project.id} />
        </div>
      </div>
    </>
  );
}
