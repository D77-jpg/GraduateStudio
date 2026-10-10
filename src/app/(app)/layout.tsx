import type { ReactNode } from "react";
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
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
