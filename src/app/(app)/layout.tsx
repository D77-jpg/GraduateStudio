import { Suspense, type ReactNode } from "react";
import { WorkspaceLoading } from "@/components/layout/workspace-loading";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { MobileNav, Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <MobileNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={session.user} />
        <main id="main-content" className="flex-1">
          {/* A stable boundary keeps an already visible workspace during React
              navigation transitions instead of replacing it with route skeletons. */}
          <Suspense fallback={<WorkspaceLoading />}>{children}</Suspense>
        </main>
      </div>
    </div>
  );
}
