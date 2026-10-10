import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { getProjectById } from "@/server/projects";
import { RuntimeView } from "@/components/features/runtime/runtime-view";
import { PageHeader, SetPageTitle } from "@/components/layout/topbar";
import { SubPageNav } from "@/components/layout/sub-page-nav";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const project = await getProjectById(id, session.user.id);
  if (!project) notFound();

  return (
    <>
      <SetPageTitle title={`运行 · ${project.name}`} />
      <SubPageNav projectId={project.id} projectName={project.name} current="运行环境" />
      <div className="w-full px-4 py-8 lg:px-10">
        <PageHeader
          title="运行环境"
          description={"启动项目的 dev server,边改边看预览与控制台输出,报错可直接交给 Agent。"}
        />
        <div className="mt-8">
          <RuntimeView projectId={project.id} />
        </div>
      </div>
    </>
  );
}
