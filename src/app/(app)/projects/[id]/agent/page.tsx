import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { getProjectById } from "@/server/projects";
import { AgentTasksView } from "@/components/features/agent/agent-tasks-view";
import { PageHeader, SetPageTitle } from "@/components/layout/topbar";
import { SubPageNav } from "@/components/layout/sub-page-nav";

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const project = await getProjectById(id, session.user.id);
  if (!project) notFound();

  return (
    <>
      <SetPageTitle title={`自主开发 · ${project.name}`} />
      <SubPageNav projectId={project.id} projectName={project.name} current="自主开发任务" />
      <div className="w-full px-4 py-8 lg:px-10">
        <PageHeader
          title="自主开发任务"
          description={`${project.name} · Agent 自动闭环:分析 → 规划 → 编码 → 自检 → 修复,全程留痕可暂停/取消`}
        />
        <div className="mt-8">
          <AgentTasksView projectId={project.id} />
        </div>
      </div>
    </>
  );
}
