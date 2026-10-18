import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { WorkspaceLoading } from "@/components/layout/workspace-loading";
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/demo/develop",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ prefetch, children, ...props }: { prefetch?: boolean; children?: ReactNode }) =>
    createElement("a", { "data-prefetch": String(prefetch), ...props }, children),
}));
import { SubPageNav } from "@/components/layout/sub-page-nav";
describe("stable workspace navigation", () => {
  it("does not immediately flash animated skeletons", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceLoading));
    expect(html).toContain("正在加载工作区");
    expect(html).not.toContain("animate-pulse");
    expect(html).toContain("min-h-[60vh]");
  });
  it("prefetches dynamic workspace stages and tools", () => {
    const html = renderToStaticMarkup(
      createElement(SubPageNav, { projectId: "demo", projectName: "测试项目", current: "开发" }),
    );
    expect((html.match(/data-prefetch="true"/g) ?? []).length).toBeGreaterThan(5);
  });
  it("keeps stable Suspense boundary and title through unmount", () => {
    expect(readFileSync("src/app/(app)/layout.tsx", "utf8")).toContain(
      "<Suspense fallback={<WorkspaceLoading />}",
    );
    expect(readFileSync("src/components/layout/topbar.tsx", "utf8")).not.toContain(
      'return () => setPageTitle("")',
    );
  });
});
