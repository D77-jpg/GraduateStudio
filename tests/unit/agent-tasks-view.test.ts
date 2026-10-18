import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const m = vi.hoisted(() => ({ query: vi.fn(), api: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: m.query,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/lib/api-client", () => ({ apiJson: m.api }));
vi.mock("@/components/features/agent/task-process-panel", () => ({ TaskProcessPanel: () => null }));

import { AgentTasksView } from "@/components/features/agent/agent-tasks-view";
beforeEach(() => {
  vi.clearAllMocks();
  m.query.mockReturnValue({
    data: { tasks: [], anyRunning: false, runningTaskIds: [] },
    isPending: false,
  });
});
describe("unbounded task controls", () => {
  it("shows user guidance without implementation or debug copy", () => {
    const html = renderToStaticMarkup(createElement(AgentTasksView, { projectId: "project" }));
    for (const text of [
      "当前执行引擎",
      "Codex CLI",
      "Legacy",
      "JSON",
      "每批 1–6",
      "模型会话",
      "最多触发两轮",
    ])
      expect(html).not.toContain(text);
    expect(html).toContain("审核后应用");
    expect(html).toContain("查看进度、暂停或取消");
  });
  it.each(["paused", "awaiting_acceptance", "applied_unverified"])(
    "renders honest local Codex capability for %s",
    (phase) => {
      m.query.mockReturnValue({
        data: {
          anyRunning: false,
          runningTaskIds: [],
          tasks: [
            {
              id: "codex",
              title: "局部任务",
              message: "需求",
              status: "paused",
              createdAt: "2026-01-02T03:04:05.000Z",
              fixAttempts: 0,
              steps: [],
              execution: {
                engine: "codex",
                mode: "local",
                phase,
                attempt: 1,
                resumable: phase === "paused",
                pendingChangeSetId: phase === "paused" ? null : "review",
              },
            },
          ],
        },
        isPending: false,
      });
      const html = renderToStaticMarkup(createElement(AgentTasksView, { projectId: "project" }));
      if (phase === "paused") {
        expect(html).toContain("从断点继续");
        expect(html).toContain("不保证延续原模型会话");
      } else {
        expect(html).not.toContain(">从断点继续<");
        expect(html).not.toContain(">恢复<");
        expect(html).toContain(phase === "awaiting_acceptance" ? "等待代码审核" : "待验收");
        if (phase === "applied_unverified") {
          expect(html).toContain("开始工程检查");
          expect(html).not.toContain("正在等待模块计划");
        }
      }
      expect(m.api).not.toHaveBeenCalled();
    },
  );
  it.each(["passed", "failed", "blocked", "running", "invalid"])(
    "uses the latest engineering result for applied task guidance: %s",
    (state) => {
      const status = state === "running" ? "passed" : state;
      const detail =
        state === "invalid"
          ? "ACCEPTANCE_REPORT\n{bad"
          : "ACCEPTANCE_REPORT\n" +
            JSON.stringify({
              version: 1,
              status,
              checks: [{ id: "check", label: "build", status, output: "evidence", durationMs: 10 }],
              limitations: [],
            });
      m.query.mockReturnValue({
        data: {
          anyRunning: state === "running",
          runningTaskIds: [],
          tasks: [
            {
              id: "codex",
              title: "task",
              message: "需求",
              status: state === "running" ? "checking" : "paused",
              createdAt: "2026-01-02T03:04:05.000Z",
              fixAttempts: 0,
              steps: [
                { id: "step", index: 1, kind: "check", title: "检查", status: "done", detail },
              ],
              execution: {
                engine: "codex",
                mode: "full",
                phase: "applied_unverified",
                resumable: false,
              },
            },
          ],
        },
        isPending: false,
      });
      const html = renderToStaticMarkup(createElement(AgentTasksView, { projectId: "project" }));
      if (state === "passed") {
        expect(html).toContain("工程检查已通过，待业务验收");
        expect(html).toContain('href="/projects/project/run"');
        expect(html).toContain("无需重复检查");
        expect(html).toContain("重新检查");
      } else if (state === "running") {
        expect(html).toContain("正在验证已应用的代码");
        expect(html).not.toContain("无需重复检查");
      } else {
        expect(html).toContain(
          state === "failed" ? "工程检查未通过，请查看下方失败项" : "工程检查受阻，请查看下方原因",
        );
        expect(html).not.toContain("无需重复检查");
      }
      expect(html).not.toContain("文件已应用，等待验证");
      expect(m.api).not.toHaveBeenCalled();
    },
  );
  it("never renders an empty-task claim after list loading fails", () => {
    const refetch = vi.fn();
    m.query.mockReturnValue({ data: undefined, isPending: false, isError: true, refetch });
    const html = renderToStaticMarkup(createElement(AgentTasksView, { projectId: "project" }));
    expect(html).toContain("不代表任务已丢失");
    expect(html).toContain("重新加载任务");
    expect(html).not.toContain("还没有任务");
    expect(refetch).not.toHaveBeenCalled();
    expect(m.api).not.toHaveBeenCalled();
  });
  it("omits local step configuration and warns honestly about billing/completion", () => {
    const html = renderToStaticMarkup(createElement(AgentTasksView, { projectId: "project" }));
    expect(html).not.toContain("<select");
    expect(html).not.toContain("执行步数上限");
    expect(html).not.toContain("预算");
    expect(html).toContain("持续产生费用");
    expect(html).toContain("不保证项目完成或耗时");
    expect(m.api).not.toHaveBeenCalled();
  });
  it("has one explicit checkpoint continue action, factual step counts and no extension prompts", () => {
    m.query.mockReturnValue({
      data: {
        anyRunning: false,
        runningTaskIds: [],
        tasks: [
          {
            id: "task",
            title: "[完整生成] 示例",
            message: "需求",
            status: "failed",
            createdAt: "2026-01-02T03:04:05.000Z",
            maxSteps: 240,
            fixAttempts: 5,
            steps: [
              {
                id: "step",
                index: 1,
                kind: "note",
                status: "done",
                title: "记录",
                detail: "",
                createdAt: "2026-01-02T03:04:05.000Z",
                finishedAt: null,
              },
            ],
          },
        ],
      },
      isPending: false,
    });
    const html = renderToStaticMarkup(createElement(AgentTasksView, { projectId: "project" }));
    expect(html.match(/从断点继续/g)).toHaveLength(1);
    expect(html).toContain("已记录 1 步");
    for (const retired of ["执行上限", "预算", "自动补充", "extend-budget"])
      expect(html).not.toContain(retired);
    expect(m.api).not.toHaveBeenCalled();
  });
  it("shows blocked acceptance guidance before repetitive logs and never resumes on render", () => {
    const report = {
      version: 1,
      status: "blocked",
      limitations: [],
      checks: [
        {
          id: "backend-test",
          label: "后端 Node 测试",
          status: "blocked",
          durationMs: 1,
          output: "真实 MySQL 集成测试环境不可用；先配置/启动测试数据库。\n# fail 14",
          failureEvidence: "test at tests/mysql.test.js:1:1\nENOTFOUND db",
        },
      ],
    };
    m.query.mockReturnValue({
      data: {
        anyRunning: false,
        runningTaskIds: [],
        tasks: [
          {
            id: "task",
            title: "[完整生成] 示例",
            message: "需求",
            status: "failed",
            createdAt: "2026-01-02T03:04:05.000Z",
            fixAttempts: 0,
            steps: [
              {
                id: "report",
                index: 1,
                kind: "check",
                status: "failed",
                title: "工程验收",
                detail: "ACCEPTANCE_REPORT\n" + JSON.stringify(report),
                createdAt: "2026-01-02T03:04:05.000Z",
                finishedAt: null,
              },
            ],
          },
        ],
      },
      isPending: false,
    });
    const html = renderToStaticMarkup(createElement(AgentTasksView, { projectId: "project" }));
    expect(html.indexOf("先处理验收阻塞，再继续")).toBeLessThan(
      html.indexOf("开发日志 · 最新在前"),
    );
    expect(html).toContain("ENOTFOUND db");
    expect(html).toContain("不会跳过测试或自动视为通过");
    expect(html.match(/>从断点继续</g)).toHaveLength(1);
    expect(m.api).not.toHaveBeenCalled();
  });
});
