import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { getProjectById } from "@/server/projects";
import { ArchitectureView } from "@/components/features/architecture/architecture-view";
import { SetPageTitle } from "@/components/layout/topbar";
import { SubPageNav } from "@/components/layout/sub-page-nav";

export default async function ArchitecturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const project = await getProjectById(id, session.user.id);
  if (!project) notFound();

  return (
    <>
      <SetPageTitle title={`系统架构 · ${project.name}`} />
      <SubPageNav projectId={project.id} projectName={project.name} current="系统架构" />
      <div className="w-full px-4 py-8 lg:px-10">
        <ArchitectureView projectId={project.id} />
      </div>
    </>
  );
}
