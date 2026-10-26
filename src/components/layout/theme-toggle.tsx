"use client";

import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";
const subscribe = (notify: () => void) => {
  window.addEventListener("studio-theme-change", notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener("studio-theme-change", notify);
    window.removeEventListener("storage", notify);
  };
};
const snapshot = (): Theme =>
  document.documentElement.dataset.theme === "dark" ? "dark" : "light";
const serverSnapshot = (): Theme => "light";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("studio-theme", next);
    } catch {
      /* Theme still works without storage. */
    }
    window.dispatchEvent(new Event("studio-theme-change"));
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
      title={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
      className={`flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-muted transition-colors hover:text-accent ${className}`}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        {theme === "dark" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
          </>
        ) : (
          <path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" />
        )}
      </svg>
    </button>
  );
}
