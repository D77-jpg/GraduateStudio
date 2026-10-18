import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentStepDto, AgentTaskDto } from "@/lib/agent";
import {
  agentStepDetailDisplay,
  latestVisibleAgentSteps,
  groupAgentSteps,
  isSafeBatchSplitStep,
} from "@/lib/agent-display";

const mocks = vi.hoisted(() => ({ query: vi.fn(), api: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: mocks.query,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/lib/api-client", () => ({ apiJson: mocks.api }));
vi.mock("@/components/features/agent/task-process-panel", () => ({ TaskProcessPanel: () => null }));
vi.mock("@/components/features/agent/acceptance-report", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/features/agent/acceptance-report")>()),
  AcceptanceReport: () => null,
}));
import { AgentTasksView } from "@/components/features/agent/agent-tasks-view";

it("groups module plans and batches newest-first without altering checkpoint order", () => {
  const steps = [
    step(1, { kind: "plan", title: "模块计划：认证" }),
    step(2, { title: "FULL_PROJECT_BATCH:task:auth:0" }),
    step(3, { kind: "plan", title: "模块计划：报名" }),
    step(4, { title: "FULL_PROJECT_BATCH:task:registration:files-0", status: "running" }),
  ];
  const groups = groupAgentSteps(
    steps,
    [
      { id: "auth", title: "认证" },
      { id: "registration", title: "报名" },
    ],
    ["auth"],
  );
  expect(groups.map((g) => g.title)).toEqual(["报名", "认证"]);
  expect(groups[0].steps.map((s) => s.index)).toEqual([4, 3]);
  expect(groups[0].defaultOpen).toBe(true);
  expect(groups[1].defaultOpen).toBe(false);
  expect(groups[1].status).toBe("done");
  expect(steps.map((s) => s.index)).toEqual([1, 2, 3, 4]);
});
it("opens the latest failed module but does not mark old recovered failures as current", () => {
  const groups = groupAgentSteps(
    [
      step(1, { kind: "plan", title: "模块计划：认证", status: "failed" }),
      step(2, { title: "FULL_PROJECT_BATCH:task:auth:0", status: "done" }),
    ],
    [{ id: "auth", title: "认证" }],
    ["auth"],
  );
  expect(groups[0].status).toBe("done");
  expect(groups[0].defaultOpen).toBe(false);
  const failed = groupAgentSteps([
    step(3, { kind: "plan", title: "模块计划：报名", status: "failed" }),
  ]);
  expect(failed[0].defaultOpen).toBe(true);
});

function step(index: number, overrides: Partial<AgentStepDto> = {}): AgentStepDto {
  return {
    id: `step-${index}`,
    index,
    kind: "code",
    title: `步骤${index}`,
    status: "done",
    detail: "",
    changeSetId: null,
    createdAt: "2026-05-01T00:00:00Z",
    finishedAt: null,
    ...overrides,
  };
}
const plan = JSON.stringify({
  title: "登录功能",
  summary: "实现用户登录与校验。",
  debug: { secret: "private-debug" },
  steps: [
    { path: "src/login.ts", action: "create", reason: "登录接口" },
    { path: "src/app.ts", action: "modify", reason: "连接页面" },
  ],
});

describe("agent timeline display", () => {
  it("collapses contiguous successful verification steps without merging separate rounds", () => {
    const rows = [
      step(1, { kind: "install", title: "安装依赖：client", status: "done" }),
      step(2, { kind: "install", title: "安装依赖：backend", status: "done" }),
      step(3, {
        kind: "check",
        title: "完整项目工程验收：构建、测试与占位检查",
        status: "done",
        detail: 'ACCEPTANCE_REPORT\n{"status":"passed"}',
      }),
      step(4, { kind: "code", title: "修复", status: "done" }),
      step(5, { kind: "install", title: "安装依赖：client", status: "running" }),
    ];
    const before = JSON.stringify(rows);
    const groups = groupAgentSteps(rows);
    expect(groups[0]).toMatchObject({
      title: "依赖检查与工程验收",
      status: "running",
      defaultOpen: true,
    });
    expect(groups[2]).toMatchObject({
      title: "依赖检查与工程验收",
      status: "done",
      defaultOpen: false,
    });
    expect(groups[2].steps.map((s) => s.index)).toEqual([3, 2, 1]);
    expect(JSON.stringify(rows)).toBe(before);
    const failedReport = { ...rows[2], detail: 'ACCEPTANCE_REPORT\n{"status":"failed"}' };
    expect(groupAgentSteps([rows[0], rows[1], failedReport])[0]).toMatchObject({
      status: "failed",
      defaultOpen: true,
    });
  });
  it("names repair modules absent from the original business plan", () => {
    const group = groupAgentSteps([
      step(9, { title: "FULL_PROJECT_BATCH:task:repair-2:files-0", status: "running" }),
    ]);
    expect(group[0].title).toBe("第 2 轮验收修复");
    expect(group[0].status).toBe("running");
  });
  it("shows exact safe-split markers as recovery, not a genuine failure", () => {
    const split = step(5, {
      kind: "code",
      status: "failed",
      title: "FULL_PROJECT_BATCH:task:auth:files-0-1",
      detail: "SAFE_BATCH_SPLIT",
    });
    expect(isSafeBatchSplitStep(split)).toBe(true);
    expect(agentStepDetailDisplay(split)).toMatchObject({
      kind: "text",
      text: expect.stringContaining("已自动拆分"),
    });
    expect(groupAgentSteps([split], [{ id: "auth", title: "认证" }])[0].status).toBe("recorded");
    expect(split.status).toBe("failed");
    expect(isSafeBatchSplitStep({ ...split, detail: "实际错误 SAFE_BATCH_SPLIT" })).toBe(false);
    expect(isSafeBatchSplitStep({ ...split, kind: "plan" })).toBe(false);
  });
  it("preserves long plan summaries and file explanations through their ending", () => {
    const summary = "完整说明".repeat(300) + "摘要末尾";
    const reason = "文件说明".repeat(150) + "说明末尾";
    const display = agentStepDetailDisplay(
      step(1, {
        kind: "plan",
        detail: JSON.stringify({
          title: "计划",
          summary,
          steps: [{ action: "create", path: "src/a.ts", reason }],
        }),
      }),
    );
    expect(display.kind).toBe("plan");
    if (display.kind !== "plan") throw new Error("unexpected display");
    expect(display.summary).toBe(summary);
    expect(display.items[0].description).toBe(reason);
  });
  it("sorts a copy by descending index including the latest running step, without mutating data", () => {
    const original = Object.freeze([step(2), step(7, { status: "running" }), step(1)]);
    const result = latestVisibleAgentSteps(original);
    expect(result.map((item) => item.index)).toEqual([7, 2, 1]);
    expect(original.map((item) => item.index)).toEqual([2, 7, 1]);
    expect(result[0]).toBe(original[1]);
  });

  it("hides checkpoint bookkeeping even when malformed and keeps original progress input", () => {
    const checkpoint = step(0, {
      title: "完整项目生成检查点",
      detail: "  FULL_PROJECT_CHECKPOINT\n{bad",
    });
    const steps = [checkpoint, step(1)];
    expect(latestVisibleAgentSteps(steps)).toEqual([steps[1]]);
    expect(steps[0]).toBe(checkpoint);
    expect(agentStepDetailDisplay(checkpoint)).toEqual({ kind: "hidden" });
    expect(agentStepDetailDisplay(step(0, { title: "完整项目生成检查点" }))).toEqual({
      kind: "hidden",
    });
  });

  it("summarizes plans with only readable allowlisted file/action fields", () => {
    expect(agentStepDetailDisplay(step(1, { kind: "plan", detail: plan }))).toEqual({
      kind: "plan",
      summary: "实现用户登录与校验。",
      countLabel: "计划处理 2 个文件",
      items: [
        { title: "新建 src/login.ts", description: "登录接口" },
        { title: "修改 src/app.ts", description: "连接页面" },
      ],
    });
  });

  it("summarizes module plans and safely handles invalid/unexpected shapes", () => {
    const modulePlan = agentStepDetailDisplay(
      step(1, {
        kind: "plan",
        detail: JSON.stringify({
          title: "开发方案",
          modules: [null, { title: "基础模块", objective: "初始化工程", modelCalls: 99 }],
        }),
      }),
    );
    expect(modulePlan).toEqual({
      kind: "plan",
      summary: "开发方案",
      countLabel: "计划实现 1 个模块",
      items: [{ title: "基础模块", description: "初始化工程" }],
    });
    for (const detail of ["{bad", "[]", '{"steps":[null,{"path":{},"reason":{}}]}']) {
      expect(agentStepDetailDisplay(step(1, { kind: "plan", detail })).kind).toBe("plan");
    }
  });

  it("preserves original failure and ordinary text context", () => {
    const failure = '<script>alert("error")</script>\nConnection refused';
    expect(
      agentStepDetailDisplay(step(1, { kind: "plan", status: "failed", detail: failure })),
    ).toEqual({ kind: "text", text: failure });
    expect(agentStepDetailDisplay(step(2, { detail: "构建通过" }))).toEqual({
      kind: "text",
      text: "构建通过",
    });
  });

  it("renders newest first, human batch titles and collapsed structured plans without API calls", () => {
    mocks.api.mockClear();
    const checkpoint = JSON.stringify({
      version: 1,
      phase: "modules",
      plan: { modules: [{ id: "auth", title: "登录模块" }] },
    });
    const steps = [
      step(0, { title: "完整项目生成检查点", detail: `FULL_PROJECT_CHECKPOINT\n${checkpoint}` }),
      step(1, { kind: "plan", detail: plan }),
      step(2, { title: "FULL_PROJECT_BATCH:task:auth:0", status: "running" }),
    ];
    const task = {
      id: "task",
      title: "开发任务",
      message: "需求",
      status: "coding",
      createdAt: "2026-05-01T00:00:00Z",
      fixAttempts: 0,
      steps,
    } as AgentTaskDto;
    mocks.query.mockReturnValue({
      data: { tasks: [task], anyRunning: true, runningTaskIds: ["task"] },
      isPending: false,
    });
    const html = renderToStaticMarkup(createElement(AgentTasksView, { projectId: "project" }));
    expect(html.indexOf("生成模块：登录模块")).toBeLessThan(html.indexOf("实现用户登录与校验。"));
    expect(html).toContain("最新在前");
    expect(html).not.toContain("FULL_PROJECT_BATCH:");
    expect(html).not.toContain("完整项目生成检查点");
    expect(html).not.toContain("FULL_PROJECT_CHECKPOINT");
    expect(html).not.toContain("private-debug");
    expect(html).not.toContain('"summary"');
    expect(html).toContain("查看计划明细");
    expect(html).toContain('<details class="mt-2"><summary');
    expect(html.match(/<details open/g)).toHaveLength(1);
    expect(html).toContain("新建 src/login.ts");
    expect(steps.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
