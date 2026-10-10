import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { getProjectById } from "@/server/projects";
import { DefenseView } from "@/components/features/defense/defense-view";
import { PageHeader, SetPageTitle } from "@/components/layout/topbar";
import { SubPageNav } from "@/components/layout/sub-page-nav";

export default async function DefensePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const project = await getProjectById(id, session.user.id);
  if (!project) notFound();

  return (
    <>
      <SetPageTitle title={`答辩中心 · ${project.name}`} />
      <SubPageNav projectId={project.id} projectName={project.name} current="答辩中心" />
      <div className="w-full px-4 py-8 lg:px-10">
        <PageHeader
          title="AI 毕业答辩中心"
          description={"按项目的真实数据出题,准备 PPT 结构与讲稿,再做模拟答辩评分。"}
        />
        <div className="mt-8">
          <DefenseView projectId={project.id} />
        </div>
      </div>
    </>
  );
}
