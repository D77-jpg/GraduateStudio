import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { getProjectById } from "@/server/projects";
import { GitView } from "@/components/features/git/git-view";
import { PageHeader, SetPageTitle } from "@/components/layout/topbar";
import { SubPageNav } from "@/components/layout/sub-page-nav";

export default async function GitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const project = await getProjectById(id, session.user.id);
  if (!project) notFound();

  return (
    <>
      <SetPageTitle title={`版本控制 · ${project.name}`} />
      <SubPageNav projectId={project.id} projectName={project.name} current="版本控制" />
      <div className="w-full px-4 py-8 lg:px-10">
        <PageHeader
          title="版本控制"
          description={"查看提交与改动,支持分支、回滚和 AI 生成提交信息。"}
        />
        <div className="mt-8">
          <GitView projectId={project.id} />
        </div>
      </div>
    </>
  );
}
