import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { getProjectById } from "@/server/projects";
import { DevelopWorkspace } from "@/components/features/develop/develop-workspace";
import { SubPageNav } from "@/components/layout/sub-page-nav";
import { SetPageTitle } from "@/components/layout/topbar";

export default async function DevelopPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const project = await getProjectById(id, session.user.id);
  if (!project) notFound();

  return (
    <>
      <SetPageTitle title={`开发 · ${project.name}`} />
      <SubPageNav projectId={project.id} projectName={project.name} current="开发工作区" />
      <DevelopWorkspace project={project} />
    </>
  );
}
