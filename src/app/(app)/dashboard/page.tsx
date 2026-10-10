import { auth } from "@/server/auth";
import { PageHeader, SetPageTitle } from "@/components/layout/topbar";
import { ProjectsView } from "@/components/features/projects/projects-view";
import { ButtonLink } from "@/components/ui/button";
import { PlusIcon } from "@/components/icons";

export default async function DashboardPage() {
  const session = await auth();
  const displayName = session?.user?.name ?? session?.user?.email;

  return (
    <>
      <SetPageTitle title="工作台" />
      <div className="page-shell">
        <p className="eyebrow mb-4">WORKSPACE / 我的工作空间</p>
        <PageHeader
          title="我的毕业设计"
          description={displayName ? `你好,${displayName}。继续推进你的毕业设计。` : undefined}
          actions={
            <ButtonLink href="/projects/new">
              <PlusIcon className="h-4 w-4" />
              新建项目
            </ButtonLink>
          }
        />
        <div className="mt-8">
          <ProjectsView />
        </div>
      </div>
    </>
  );
}
