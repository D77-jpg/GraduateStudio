"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { signOutAction } from "@/app/(app)/actions";
import { LogOutIcon, MenuIcon, SettingsIcon } from "@/components/icons";
import { useUiStore } from "@/stores/ui-store";

function displayName(name?: string | null, email?: string | null): string {
  return name || email || "用户";
}

function initialOf(name?: string | null, email?: string | null): string {
  const source = displayName(name, email);
  return source.slice(0, 1).toUpperCase();
}

function UserMenu({ name, email }: { name?: string | null; email?: string | null }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full border border-zinc-200 py-1 pl-1 pr-2.5 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-600/10 text-xs font-semibold text-violet-700 dark:text-violet-400">
          {initialOf(name, email)}
        </span>
        <span className="max-w-28 truncate text-zinc-700 dark:text-zinc-300">
          {displayName(name, email)}
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-2 w-44 rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          <div className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
            <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {displayName(name, email)}
            </p>
            {email && name ? (
              <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{email}</p>
            ) : null}
          </div>
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="mt-1 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <SettingsIcon className="h-4 w-4" />
            设置
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <LogOutIcon className="h-4 w-4" />
              退出登录
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

export function Topbar({
  user,
}: {
  user: { name?: string | null; email?: string | null } | null;
}) {
  const pageTitle = useUiStore((s) => s.pageTitle);
  const setMobileNavOpen = useUiStore((s) => s.setMobileNavOpen);

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200/80 bg-white/80 px-4 backdrop-blur dark:border-zinc-800/80 dark:bg-zinc-900/70">
      <button
        type="button"
        aria-label="打开导航"
        onClick={() => setMobileNavOpen(true)}
        className="-ml-1.5 rounded-lg p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 md:hidden"
      >
        <MenuIcon />
      </button>
      <span className="text-sm font-semibold tracking-tight text-zinc-900 md:hidden dark:text-zinc-100">
        GraduateStudio
      </span>

      {pageTitle ? (
        <span className="hidden text-sm text-zinc-400 md:block dark:text-zinc-500">
          {pageTitle}
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        <UserMenu name={user?.name} email={user?.email} />
      </div>
    </header>
  );
}

export function SetPageTitle({ title }: { title: string }) {
  const setPageTitle = useUiStore((s) => s.setPageTitle);

  useEffect(() => {
    setPageTitle(title);
    return () => setPageTitle("");
  }, [title, setPageTitle]);

  return null;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
