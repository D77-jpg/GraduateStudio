import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTaskDto } from "@/lib/agent";
const m = vi.hoisted(() => ({ query: vi.fn(), api: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: m.query }));
vi.mock("@/lib/api-client", () => ({ apiJson: m.api }));
import { TaskProcessPanel } from "@/components/features/agent/task-process-panel";
beforeEach(() => vi.clearAllMocks());
it("shows newest activity first regardless of API order, collapses details, and sends no mutations", () => {
  const logs = [
    {
      id: "old",
      kind: "ai",
      message: "较早记录",
      detail: "older detail",
      createdAt: "2026-01-01T10:00:00Z",
    },
    {
      id: "new",
      kind: "ai",
      message: "最新记录",
      detail: "latest detail",
      createdAt: "2026-01-01T11:00:00Z",
    },
  ];
  m.query.mockImplementation((opts: { queryKey: string[] }) => ({
    data: opts.queryKey[0] === "agent-process-logs" ? { logs } : { changeSets: [] },
    isPending: false,
    isError: false,
  }));
  const task = {
    id: "task",
    status: "coding",
    createdAt: "2026-01-01T09:00:00Z",
    startedAt: "2026-01-01T09:00:00Z",
    finishedAt: null,
    steps: [],
    gitCommitHash: null,
  } as unknown as AgentTaskDto;
  const html = renderToStaticMarkup(
    createElement(TaskProcessPanel, { projectId: "project", task }),
  );
  expect(html.indexOf("最新记录")).toBeLessThan(html.indexOf("较早记录"));
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
  expect(html).not.toContain("日志每 3 秒");
  expect(html).toContain("正在生成代码，完成校验后自动更新文件");
  expect(html).not.toContain("正在等待生成结果");
  expect(logs[0].id).toBe("old");
  expect(m.api).not.toHaveBeenCalled();
});
