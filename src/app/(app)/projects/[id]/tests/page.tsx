import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { getProjectById } from "@/server/projects";
import { TestingCenterView } from "@/components/features/testing/testing-center-view";
import { PageHeader, SetPageTitle } from "@/components/layout/topbar";
import { SubPageNav } from "@/components/layout/sub-page-nav";

export default async function TestsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const project = await getProjectById(id, session.user.id);
  if (!project) notFound();

  return (
    <>
      <SetPageTitle title={`测试中心 · ${project.name}`} />
      <SubPageNav projectId={project.id} projectName={project.name} current="测试中心" />
      <div className="w-full px-4 py-8 lg:px-10">
        <PageHeader
          title="测试中心"
          description={"生成并真实运行 Vitest 测试,失败用例可交给 AI 修复后重跑。"}
        />
        <div className="mt-8">
          <TestingCenterView projectId={project.id} />
        </div>
      </div>
    </>
  );
}
