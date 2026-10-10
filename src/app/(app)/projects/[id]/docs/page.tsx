import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { getProjectById } from "@/server/projects";
import { DocumentsView } from "@/components/features/documents/documents-view";
import { PageHeader, SetPageTitle } from "@/components/layout/topbar";
import { SubPageNav } from "@/components/layout/sub-page-nav";

export default async function DocsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const project = await getProjectById(id, session.user.id);
  if (!project) notFound();

  return (
    <>
      <SetPageTitle title={`毕设文档 · ${project.name}`} />
      <SubPageNav projectId={project.id} projectName={project.name} current="毕设文档" />
      <div className="w-full px-4 py-8 lg:px-10">
        <PageHeader
          title="AI 毕设文档中心"
          description={"用需求、架构、数据库、代码与测试等真实数据生成毕设文档,可 AI 改写并导出。"}
        />
        <div className="mt-8">
          <DocumentsView projectId={project.id} />
        </div>
      </div>
    </>
  );
}
