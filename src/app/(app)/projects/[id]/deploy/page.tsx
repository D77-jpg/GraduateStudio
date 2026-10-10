import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { getProjectById } from "@/server/projects";
import { DeployView } from "@/components/features/deploy/deploy-view";
import { PageHeader, SetPageTitle } from "@/components/layout/topbar";
import { SubPageNav } from "@/components/layout/sub-page-nav";

export default async function DeployPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const project = await getProjectById(id, session.user.id);
  if (!project) notFound();

  return (
    <>
      <SetPageTitle title={`部署 · ${project.name}`} />
      <SubPageNav projectId={project.id} projectName={project.name} current="部署中心" />
      <div className="w-full px-4 py-8 lg:px-10">
        <PageHeader
          title="部署中心"
          description={"生成 Docker 部署资产,在本机完成构建、启动、看日志与回滚。"}
        />
        <div className="mt-8">
          <DeployView projectId={project.id} />
        </div>
      </div>
    </>
  );
}
