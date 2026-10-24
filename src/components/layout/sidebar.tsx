"use client";

import { useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiJson } from "@/lib/api-client";
import { useUiStore } from "@/stores/ui-store";
import { HomeIcon, SettingsIcon, PlusIcon, FolderIcon, XIcon } from "@/components/icons";

/**
 * 全局侧边栏:工作台 / 新建项目(选题入口)/ 最近项目(直达项目详情)。
 * 功能型页面(需求/架构/开发/测试/文档/答辩/部署)在项目详情页内导航,
 * 侧边栏保持全局轻量,不再展示"即将上线"占位(全部功能已落地)。
 */

const MAIN_NAV = [
  { href: "/dashboard", label: "工作台", icon: HomeIcon },
  { href: "/projects/new", label: "新建项目", icon: PlusIcon },
  { href: "/settings", label: "设置", icon: SettingsIcon },
] as const;

interface RecentProject {
  id: string;
  name: string;
  stage: string;
  progress: number;
}

function Logo() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2 px-2">
      <Image
        src="/brand/graduatestudio-mark.png"
        alt=""
        width={490}
        height={217}
        priority
        className="h-7 w-auto dark:invert"
      />
      <span className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
        GraduateStudio
      </span>
    </Link>
  );
}

function NavContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const projectsQuery = useQuery({
    queryKey: ["sidebar-projects"],
    queryFn: () => apiJson<{ projects: RecentProject[] }>("/api/projects"),
    staleTime: 30_000,
  });
  const projects = (projectsQuery.data?.projects ?? []).slice(0, 5);

  const isProjectHome = /^\/projects\/[^/]+(?:\/|$)/.test(pathname);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center md:hidden">
        <Logo />
        <button
          type="button"
          aria-label="关闭导航"
          onClick={onNavigate}
          className="ml-auto mr-3 rounded-lg p-2 text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
        >
          <XIcon />
        </button>
      </div>
      <div className="hidden h-14 shrink-0 items-center px-2 md:flex">
        <Logo />
      </div>

      <nav className="mt-2 flex-1 space-y-1 overflow-y-auto px-3">
        {MAIN_NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              prefetch={true}
              onClick={onNavigate}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-accent-soft font-medium text-accent"
                  : "text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100"
              }`}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              {label}
            </Link>
          );
        })}

        <div className="pt-6">
          <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
            最近项目
          </p>
          <div className="mt-1.5 space-y-0.5">
            {projectsQuery.isPending ? (
              <p className="px-3 py-2 text-xs text-zinc-400">加载中…</p>
            ) : projects.length === 0 ? (
              <p className="px-3 py-2 text-xs text-zinc-400">还没有项目,点击「新建项目」开始</p>
            ) : (
              projects.map((project) => {
                const active = isProjectHome && pathname.includes(project.id);
                return (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    prefetch={true}
                    onClick={onNavigate}
                    title={project.name}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                      active
                        ? "bg-accent-soft font-medium text-accent"
                        : "text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100"
                    }`}
                  >
                    <FolderIcon className="h-[18px] w-[18px] shrink-0 text-zinc-400" />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
                      {project.progress}%
                    </span>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      </nav>

      <div className="shrink-0 border-t border-zinc-200/80 px-5 py-3.5 dark:border-zinc-800/80">
        <p className="text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-600">
          AI 毕业设计工作台
          <a
            href="https://sevnai.site"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 block font-mono tracking-wider text-muted transition-colors hover:text-accent"
          >
            BY SEVN AILAB ↗
          </a>
        </p>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-line bg-surface md:block">
      <NavContent />
    </aside>
  );
}

export function MobileNav() {
  const open = useUiStore((s) => s.mobileNavOpen);
  const setOpen = useUiStore((s) => s.setMobileNavOpen);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-zinc-950/40 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />
      <div className="absolute inset-y-0 left-0 w-64 border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <NavContent onNavigate={() => setOpen(false)} />
      </div>
    </div>
  );
}
