import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AgentTask } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexCheckpoint } from "@/server/agents/codex-checkpoint";
import type { TaskControl } from "@/server/agents/runner";
import type { AgentEngine, AgentEngineTask } from "@/server/agents/engine";
import type { RuntimeRepairEvidenceReport } from "@/server/runtime/codex-runtime-diagnostics";

const mocks = vi.hoisted(() => ({
  root: "",
  stage: "",
  db: {
    requirement: { findUnique: vi.fn() },
    agentTask: { update: vi.fn(), updateMany: vi.fn() },
    agentStep: { updateMany: vi.fn() },
    changeSet: { findFirst: vi.fn() },
  },
  runStep: vi.fn(),
  release: vi.fn(),
  createCheckpoint: vi.fn(),
  saveCheckpoint: vi.fn(),
  createEngine: vi.fn(),
  cleanupStage: vi.fn(),
  acquireLease: vi.fn(),
  releaseLease: vi.fn(),
  prepareDependencies: vi.fn(),
  runAcceptance: vi.fn(),
  collectRuntimeRepairEvidence: vi.fn(),
  run: vi.fn(),
  dispose: vi.fn(),
  propose: vi.fn(),
  accept: vi.fn(),
  activity: vi.fn(),
  legacyPlan: vi.fn(),
  legacyImplementation: vi.fn(),
  legacyGenerate: vi.fn(),
}));
vi.mock("@/server/db", () => ({ db: mocks.db }));
vi.mock("@/server/workspace/paths", () => ({ ensureProjectDir: () => mocks.root }));
vi.mock("@/server/changesets", () => ({
  createPendingChangeSet: mocks.propose,
  acceptChangeSet: mocks.accept,
}));
vi.mock("@/server/activity", () => ({ logActivity: mocks.activity }));
vi.mock("@/server/agents/runner", () => ({
  runStep: mocks.runStep,
  releaseTaskController: mocks.release,
}));
vi.mock("@/server/agents/codex-checkpoint", () => ({
  createCodexCheckpoint: mocks.createCheckpoint,
  saveCodexCheckpoint: mocks.saveCheckpoint,
}));
vi.mock("@/server/agents/codex-container", () => ({
  createIsolatedCodexEngine: mocks.createEngine,
  cleanupCodexStage: mocks.cleanupStage,
}));
vi.mock("@/server/agents/codex-lease", () => ({
  acquireCodexProjectLease: mocks.acquireLease,
}));
vi.mock("@/server/agents/codex-dependencies", () => ({
  prepareCodexDependencies: mocks.prepareDependencies,
}));
vi.mock("@/server/agents/codex-acceptance", () => ({
  runCodexAcceptance: mocks.runAcceptance,
}));
// 编排层现在调用交付闸门；沿用 runAcceptance 这个 mock 作为闸门结果来源（签名 (stage, signal)）。
vi.mock("@/server/agents/delivery-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/agents/delivery-gate")>();
  return {
    ...actual,
    runDeliveryGate: (stage: string, options?: { signal?: AbortSignal }) =>
      mocks.runAcceptance(stage, options?.signal),
    ensureGateCacheVolume: async () => null,
  };
});
// 项目上下文来自数据库；夹具里不写 AGENTS.md，避免改变既有变更集断言。
vi.mock("@/server/agents/codex-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/agents/codex-context")>();
  return {
    ...actual,
    loadCodexProjectContext: async () => ({
      projectText: "",
      requirementText: "",
      architectureText: "",
    }),
    ensureAgentsMd: async () => false,
  };
});
// Never import the real runtime boundary: the orchestration suite must not inspect
// containers, retry business tasks, or make model requests even for repair prompts.
vi.mock("@/server/runtime/codex-runtime-diagnostics", () => ({
  collectRuntimeRepairEvidence: mocks.collectRuntimeRepairEvidence,
}));
// Spy on the real filesystem implementations: conflicts and proposals must be based on
// bytes in the fixture, not independently scripted inventories or synthetic diffs.
vi.mock("@/server/agents/codex-workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/agents/codex-workspace")>();
  return {
    ...actual,
    snapshot: vi.fn(actual.snapshot),
    workspaceDiff: vi.fn(actual.workspaceDiff),
  };
});
vi.mock("@/server/agents/codex-assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/agents/codex-assets")>();
  return {
    ...actual,
    inventoryWorkspace: vi.fn(actual.inventoryWorkspace),
    assertInventoryUnchanged: vi.fn(actual.assertInventoryUnchanged),
    assertBinaryUnchanged: vi.fn(actual.assertBinaryUnchanged),
  };
});
vi.mock("@/server/agents/coding-agent", () => ({
  generatePlan: mocks.legacyPlan,
  generateImplementation: mocks.legacyImplementation,
}));
vi.mock("@/server/ai/compat", () => ({ generateObjectCompat: mocks.legacyGenerate }));

import { executeCodexTask } from "@/server/agents/codex-task";
import { inventoryWorkspace } from "@/server/agents/codex-assets";
import { snapshot } from "@/server/agents/codex-workspace";

const task = { id: "task-fixture", startedAt: null } as AgentTask;
const requirement = {
  id: "requirement-fixture",
  projectId: "project-fixture",
  features: [
    { id: "feature-a", title: "Inventory" },
    { id: "feature-b", title: "Checkout" },
  ],
  roles: [{ id: "role-a", name: "Customer" }],
};
const smokeFor = (resource: string, title: string) => [
  {
    kind: "http",
    as: "admin",
    method: "POST",
    path: `/api/${resource}`,
    body: { name: "fixture" },
    expectStatus: 200,
    saveAs: { itemId: "data.id" },
  },
  {
    kind: "http",
    as: "admin",
    method: "GET",
    path: `/api/${resource}/{{itemId}}`,
    expectStatus: 200,
  },
  { kind: "page", as: "admin", route: `/${resource}`, expectText: [title] },
];
const passedGate = { status: "passed", checks: [] };
const modulePlan = {
  version: 2,
  modules: [
    {
      id: "checkout",
      title: "Checkout",
      dependsOn: ["foundation"],
      featureIds: ["feature-b"],
      acceptanceCriteria: ["checkout persists"],
      smoke: smokeFor("orders", "Checkout"),
    },
    {
      id: "foundation",
      title: "Foundation",
      dependsOn: [],
      featureIds: ["feature-a"],
      acceptanceCriteria: ["inventory persists"],
      smoke: smokeFor("inventory", "Inventory"),
    },
  ],
};
const repairMessage = "修复任务 #9 的模型连接失败，不修改界面";
const runtimeRepairReport: RuntimeRepairEvidenceReport = {
  version: 1,
  status: "collected",
  taskId: 9,
  taskState: "failed",
  failureCode: "MODEL_CONNECT_ERROR",
  failureSummary: "The task recorded a model connection failure.",
  endpoint: { serviceId: 2, port: 11434, hostKind: "loopback" },
  connectivity: "refused",
  modelCalls: 0,
  needsUserAction: true,
  issues: ["Loopback refers to the backend container itself, not the host computer."],
};
const success = {
  runId: "fixture-run",
  engine: "codex",
  exitCode: 0,
  threadId: null,
  lastMessage: "Generated; independent acceptance not run",
  changedPaths: [],
  violations: [],
};
let fixture: string;
let checkpoint: CodexCheckpoint;
let ctrl: TaskControl;
let stepChangeSet: ReturnType<typeof vi.fn>;
let checkpointHistory: CodexCheckpoint[];
const designSkills = [
  { id: "ui-ux-pro-max", revision: "fixture-ui-revision" },
  { id: "frontend-design", revision: "fixture-frontend-revision" },
];
const designFiles = {
  "MASTER.md": [
    "主题：库存结算工作台",
    "用户：负责库存与结算的店员",
    "主任务：核对库存后完成结算",
    "布局：以待结算商品清单为主，库存摘要为辅",
    "反模板：不用通用仪表盘卡片堆砌，优先展示交易明细",
    "字体：system-ui, sans-serif 系统回退",
    "配色：浅色背景、深色正文、蓝绿色标记结算操作",
  ].join("\n"),
  "tokens.json": JSON.stringify({
    version: 1,
    colors: { background: "#f6f8f7", foreground: "#152825", primary: "#24685a" },
    typography: { fontFamily: "system-ui, sans-serif", headingFamily: "system-ui, sans-serif" },
    spacing: { sm: "4px", md: "8px", lg: "16px" },
    radius: { sm: "4px", md: "8px" },
  }),
  "pages/checkout.md":
    "主任务：核对库存并结算。布局：商品清单和总额。交互：确认后保存。响应式：小屏纵排。无障碍：键盘操作及可见焦点。\n",
};
async function seedDesign(root = mocks.root, uiOnly = false) {
  const prefix = uiOnly ? "client/design-system" : "design-system";
  for (const [relative, content] of Object.entries(designFiles)) {
    const target = path.join(root, prefix, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}
function expectDesignPrompt(prompt: string, directory = "design-system") {
  expect(prompt).toContain(`规范目录：${directory}`);
  expect(prompt).toContain("MASTER.md、tokens.json");
  expect(prompt).toContain("pages/*.md");
  expect(prompt).toContain("/opt/gs-design-skills");
  expect(prompt).toContain("UI UX Pro Max");
  expect(prompt).toContain("frontend-design");
  expect(prompt).toContain("先读取实际 SKILL.md");
  expect(prompt).toContain("禁止 --persist");
  expect(prompt).toContain("不可虚构截图");
}

async function writeStage(relative: string, content: string) {
  const target = path.join(mocks.stage, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}
async function journal() {
  return JSON.parse(
    await fs.readFile(path.join(path.dirname(mocks.stage), "journal.json"), "utf8"),
  );
}
function execute(
  options: Parameters<typeof executeCodexTask>[5] = {},
  message = "Implement checkout",
) {
  return executeCodexTask(task, "project-fixture", "user-fixture", message, ctrl, options);
}
function lastTaskUpdate() {
  return mocks.db.agentTask.update.mock.calls.at(-1)?.[0].data;
}
function expectNoLegacyOrAcceptance() {
  expect(mocks.accept).not.toHaveBeenCalled();
  expect(mocks.legacyPlan).not.toHaveBeenCalled();
  expect(mocks.legacyImplementation).not.toHaveBeenCalled();
  expect(mocks.legacyGenerate).not.toHaveBeenCalled();
}
async function prepareResume(mode: "local" | "full" = "local") {
  if (mode === "full") await seedDesign();
  const baseline = Object.fromEntries(await snapshot(mocks.root));
  checkpoint = await mocks.createCheckpoint({
    taskId: task.id,
    projectId: "project-fixture",
    mode,
    message: "Implement checkout",
    baseline,
    requirementHash:
      mode === "full"
        ? createHash("sha256").update(JSON.stringify(requirement)).digest("hex")
        : null,
  });
  const inventory = await inventoryWorkspace(mocks.root, mocks.stage);
  await fs.writeFile(
    path.join(path.dirname(mocks.stage), "journal.json"),
    JSON.stringify({ inventory, plan: null, done: [] }),
  );
  checkpoint.phase = "paused";
  vi.clearAllMocks();
}

beforeEach(async () => {
  vi.resetAllMocks();
  // Restore the real implementations after resetting the boundary spies.
  const workspace = await vi.importActual<typeof import("@/server/agents/codex-workspace")>(
    "@/server/agents/codex-workspace",
  );
  const assets = await vi.importActual<typeof import("@/server/agents/codex-assets")>(
    "@/server/agents/codex-assets",
  );
  const mockedWorkspace = await import("@/server/agents/codex-workspace");
  const mockedAssets = await import("@/server/agents/codex-assets");
  vi.mocked(mockedWorkspace.snapshot).mockImplementation(workspace.snapshot);
  vi.mocked(mockedWorkspace.workspaceDiff).mockImplementation(workspace.workspaceDiff);
  vi.mocked(mockedAssets.inventoryWorkspace).mockImplementation(assets.inventoryWorkspace);
  vi.mocked(mockedAssets.assertInventoryUnchanged).mockImplementation(
    assets.assertInventoryUnchanged,
  );
  vi.mocked(mockedAssets.assertBinaryUnchanged).mockImplementation(assets.assertBinaryUnchanged);
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), "codex-orchestration-test-"));
  mocks.root = path.join(fixture, "original");
  mocks.stage = path.join(fixture, "state", "stage");
  await fs.mkdir(path.join(mocks.root, "client"), { recursive: true });
  await fs.writeFile(path.join(mocks.root, "client", "app.ts"), "export const checkout = false;\n");
  await fs.writeFile(path.join(mocks.root, "README.md"), "Original project\n");
  ctrl = { cancelled: false, paused: false, abort: new AbortController(), engine: "codex" };
  checkpointHistory = [];
  stepChangeSet = vi.fn();
  mocks.db.requirement.findUnique.mockResolvedValue(requirement);
  mocks.db.agentTask.update.mockResolvedValue({});
  mocks.db.agentTask.updateMany.mockResolvedValue({ count: 1 });
  mocks.db.agentStep.updateMany.mockResolvedValue({ count: 1 });
  mocks.db.changeSet.findFirst.mockResolvedValue(null);
  mocks.propose.mockResolvedValue({ id: "proposal-fixture" });
  mocks.activity.mockResolvedValue(undefined);
  mocks.dispose.mockResolvedValue(undefined);
  mocks.cleanupStage.mockResolvedValue(undefined);
  mocks.releaseLease.mockResolvedValue(undefined);
  mocks.acquireLease.mockResolvedValue(mocks.releaseLease);
  mocks.prepareDependencies.mockResolvedValue({
    status: "blocked",
    reason: "Offline fixture: dependencies not installed",
  });
  mocks.runAcceptance.mockResolvedValue({ status: "blocked", checks: [] });
  mocks.collectRuntimeRepairEvidence.mockResolvedValue(null);
  mocks.createEngine.mockResolvedValue({
    engine: { id: "codex", run: mocks.run },
    metadata: {
      model: "fixture-model",
      isolation: "fixture-isolation",
      designSkillsRevision: "fixture-bundle-revision",
      designSkills,
    },
    dispose: mocks.dispose,
  });
  mocks.run.mockImplementation(async () => {
    await writeStage("client/app.ts", "export const checkout = true;\n");
    return success;
  });
  mocks.runStep.mockImplementation(async (_task, _index, _kind, _title, action) =>
    action({ setChangeSet: stepChangeSet }),
  );
  mocks.createCheckpoint.mockImplementation(async (input) => {
    await fs.mkdir(mocks.stage, { recursive: true });
    checkpoint = {
      ...input,
      version: 1,
      engine: "codex",
      stage: mocks.stage,
      phase: "running",
      attempt: 0,
      nextStepIndex: 0,
      requirementHash: input.requirementHash ?? null,
      pendingChangeSetId: null,
      error: null,
      updatedAt: new Date().toISOString(),
    };
    return checkpoint;
  });
  mocks.saveCheckpoint.mockImplementation(async (cp: CodexCheckpoint) => {
    checkpointHistory.push(structuredClone(cp));
    await fs.writeFile(path.join(fixture, "state", "checkpoint.json"), JSON.stringify(cp));
  });
});
afterEach(async () => {
  expectNoLegacyOrAcceptance();
  vi.restoreAllMocks();
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
});

describe("executeCodexTask orchestration (fixture filesystem, no CLI/network/model calls)", () => {
  it("proposes actual local text changes, stays pending, and never writes back or claims acceptance", async () => {
    await execute();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.createEngine).toHaveBeenCalledWith(
      mocks.stage,
      ctrl.abort.signal,
      expect.any(Object),
    );
    expect(mocks.prepareDependencies).toHaveBeenCalledExactlyOnceWith(
      mocks.stage,
      ctrl.abort.signal,
    );
    expect(mocks.runAcceptance).toHaveBeenCalledExactlyOnceWith(mocks.stage, ctrl.abort.signal);
    expect(mocks.prepareDependencies.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createEngine.mock.invocationCallOrder[0],
    );
    expect(mocks.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runAcceptance.mock.invocationCallOrder[0],
    );
    expect(mocks.runAcceptance.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.propose.mock.invocationCallOrder[0],
    );
    expect(
      JSON.parse(await fs.readFile(path.join(fixture, "state/dependencies.json"), "utf8")),
    ).toMatchObject({ status: "blocked" });
    expect(
      JSON.parse(await fs.readFile(path.join(fixture, "state/acceptance.json"), "utf8")),
    ).toEqual({ status: "blocked", checks: [] });
    expect(mocks.run.mock.calls[0][0]).toMatchObject({
      workspace: mocks.stage,
      projectId: "project-fixture",
      mode: "workspace-write",
      signal: ctrl.abort.signal,
    });
    expect(mocks.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-fixture",
        userId: "user-fixture",
        changes: [
          { action: "modify", path: "client/app.ts", content: "export const checkout = true;\n" },
        ],
        plan: [{ action: "modify", path: "client/app.ts" }],
        summary: expect.stringContaining("不代表可交付"),
      }),
    );
    expect(await fs.readFile(path.join(mocks.root, "client/app.ts"), "utf8")).toBe(
      "export const checkout = false;\n",
    );
    expect(checkpoint).toMatchObject({
      phase: "awaiting_acceptance",
      pendingChangeSetId: "proposal-fixture",
      attempt: 1,
      nextStepIndex: 3,
    });
    expect(stepChangeSet).toHaveBeenCalledWith("proposal-fixture");
    expect(lastTaskUpdate()).toMatchObject({ status: "paused", finishedAt: null });
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
  });

  it("repairs failed independent checks through Codex, rechecks actual changed bytes and reports passed without autoaccept", async () => {
    const failed = {
      status: "failed",
      checks: [{ name: "tests", status: "failed", output: "checkout assertion failed" }],
    };
    const passed = {
      status: "passed",
      checks: [{ name: "tests", status: "passed", output: "1 passed" }],
    };
    mocks.runAcceptance.mockResolvedValueOnce(failed).mockResolvedValueOnce(passed);
    mocks.run
      .mockImplementationOnce(async () => {
        await writeStage("client/app.ts", "export const checkout = true;\n");
        return success;
      })
      .mockImplementationOnce(async () => {
        await writeStage("client/app.ts", "export const checkout = { enabled: true };\n");
        return success;
      });
    await execute();
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.createEngine).toHaveBeenCalledTimes(2);
    expect(mocks.dispose).toHaveBeenCalledTimes(2);
    expect(mocks.runAcceptance).toHaveBeenCalledTimes(2);
    expect(mocks.run.mock.calls[1][0].prompt).toContain("checkout assertion failed");
    expect(mocks.run.mock.calls[1][0].prompt).toContain("不准删测试");
    expect(mocks.runStep.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ["code", "Codex：检查代码 → 修改 → 检查"],
      ["code", "Codex：修复交付闸门失败（局部修改 1/3）"],
      ["check", "交付闸门 · 局部修改：passed"],
      ["note", "待用户审阅：交付闸门 passed"],
    ]);
    expect(
      JSON.parse(
        await fs.readFile(path.join(fixture, "state/gate-before-repair-局部修改-1-0.json"), "utf8"),
      ),
    ).toEqual(failed);
    expect(
      JSON.parse(await fs.readFile(path.join(fixture, "state/acceptance.json"), "utf8")),
    ).toEqual(passed);
    expect(mocks.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("交付闸门：passed"),
        changes: [
          {
            action: "modify",
            path: "client/app.ts",
            content: "export const checkout = { enabled: true };\n",
          },
        ],
      }),
    );
    expect(checkpoint.phase).toBe("awaiting_acceptance");
    expect(lastTaskUpdate()).toMatchObject({ status: "paused", finishedAt: null });
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
  });

  it("does not spend a repair invocation on blocked independent checks", async () => {
    await execute();
    expect(mocks.runAcceptance).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.createEngine).toHaveBeenCalledTimes(1);
    expect(mocks.propose.mock.calls[0][0].summary).toContain("交付闸门：blocked");
    expect(
      mocks.runStep.mock.calls.filter((call) => String(call[3]).includes("修复交付闸门失败")),
    ).toHaveLength(0);
  });

  it.each(["repeated evidence", "no actual diff", "three repair budget"])(
    "stops Codex repairs at %s and truthfully retains failed acceptance",
    async (stop) => {
      const failure = (message: string) => ({
        status: "failed",
        checks: [{ name: "tests", status: "failed", output: message }],
      });
      const first = failure("first failure");
      const second = failure("second failure");
      const third = failure("third failure");
      const fourth = failure("fourth failure");
      if (stop === "three repair budget")
        mocks.runAcceptance
          .mockResolvedValueOnce(first)
          .mockResolvedValueOnce(second)
          .mockResolvedValueOnce(third)
          .mockResolvedValueOnce(fourth);
      else mocks.runAcceptance.mockResolvedValue(first);
      let invocations = 0;
      mocks.run.mockImplementation(async () => {
        invocations++;
        if (invocations === 1 || stop !== "no actual diff")
          await writeStage("client/app.ts", `// implementation revision ${invocations}\n`);
        return success;
      });
      await execute();
      const expectedRuns = stop === "three repair budget" ? 4 : 2;
      expect(mocks.run).toHaveBeenCalledTimes(expectedRuns);
      expect(mocks.createEngine).toHaveBeenCalledTimes(expectedRuns);
      expect(mocks.dispose).toHaveBeenCalledTimes(expectedRuns);
      expect(mocks.runAcceptance).toHaveBeenCalledTimes(
        stop === "no actual diff" ? 1 : expectedRuns,
      );
      expect(mocks.propose.mock.calls[0][0].summary).toContain("交付闸门：failed");
      expect(
        JSON.parse(await fs.readFile(path.join(fixture, "state/acceptance.json"), "utf8")),
      ).toEqual(stop === "three repair budget" ? fourth : first);
      expect(checkpoint.phase).toBe("awaiting_acceptance");
      expect(lastTaskUpdate()).toMatchObject({ status: "paused", finishedAt: null });
      expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
    },
  );

  it("does not trust a successful model message without a real auditable diff", async () => {
    mocks.run.mockResolvedValue({ ...success, lastMessage: "All implementation and tests passed" });
    await execute();
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(checkpoint.phase).toBe("failed");
    expect(lastTaskUpdate()).toMatchObject({
      status: "failed",
      error: expect.stringContaining("未检测到可审计"),
    });
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
  });

  describe("runtime repair evidence and bounded exploration", () => {
    it("collects and records task #9 evidence before the engine, then keeps real file changes pending human review", async () => {
      mocks.collectRuntimeRepairEvidence.mockResolvedValue(runtimeRepairReport);
      await execute({}, repairMessage);
      expect(mocks.collectRuntimeRepairEvidence).toHaveBeenCalledExactlyOnceWith(
        "project-fixture",
        repairMessage,
        ctrl.abort.signal,
      );
      const firstStep = mocks.runStep.mock.calls[0];
      expect(firstStep.slice(1, 4)).toEqual([0, "note", "运行故障诊断：仅观察，不重试模型"]);
      expect(await mocks.runStep.mock.results[0].value).toBe(
        "RUNTIME_REPAIR_REPORT\n" + JSON.stringify(runtimeRepairReport),
      );
      expect(mocks.collectRuntimeRepairEvidence.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.runStep.mock.invocationCallOrder[0],
      );
      expect(mocks.runStep.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.createEngine.mock.invocationCallOrder[0],
      );
      const prompt = mocks.run.mock.calls[0][0].prompt;
      expect(prompt).toContain(JSON.stringify(runtimeRepairReport));
      expect(prompt).toContain("【运行故障诊断合同】");
      expect(prompt).toContain("不要把任务编号当成开发步骤");
      expect(prompt).toContain("禁止自动启动模型请求、重试业务生成任务、修改实际模型配置");
      expect(prompt).toContain("收费调用和配置变更需要用户确认");
      expect(mocks.runAcceptance).toHaveBeenCalledTimes(1);
      expect(mocks.propose).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          changes: [
            { action: "modify", path: "client/app.ts", content: "export const checkout = true;\n" },
          ],
        }),
      );
      expect(mocks.accept).not.toHaveBeenCalled();
      expect(checkpoint).toMatchObject({
        phase: "awaiting_acceptance",
        pendingChangeSetId: "proposal-fixture",
      });
      expect(lastTaskUpdate()).toMatchObject({ status: "paused", finishedAt: null });
      expect(await fs.readFile(path.join(mocks.root, "client/app.ts"), "utf8")).toBe(
        "export const checkout = false;\n",
      );
    });

    it("reobserves unchanged bytes and pauses without acceptance or a synthetic proposal, rather than failing", async () => {
      const finalReport = { ...runtimeRepairReport, connectivity: "connected" as const };
      mocks.collectRuntimeRepairEvidence
        .mockResolvedValueOnce(runtimeRepairReport)
        .mockResolvedValueOnce(finalReport);
      mocks.run.mockResolvedValue({
        ...success,
        lastMessage: "Connection repaired; everything passed",
      });
      await execute({}, repairMessage);
      expect(mocks.collectRuntimeRepairEvidence).toHaveBeenCalledTimes(2);
      expect(mocks.dispose.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.collectRuntimeRepairEvidence.mock.invocationCallOrder[1],
      );
      expect(mocks.runStep.mock.calls.map((call) => [call[2], call[3]])).toEqual([
        ["note", "运行故障诊断：仅观察，不重试模型"],
        ["code", "Codex：检查代码 → 修改 → 检查"],
        ["note", "运行故障复核：未应用代码，不代表已修复"],
      ]);
      expect(await mocks.runStep.mock.results[2].value).toBe(
        "RUNTIME_REPAIR_REPORT\n" + JSON.stringify(finalReport),
      );
      expect(checkpoint).toMatchObject({ phase: "paused", pendingChangeSetId: null });
      expect(checkpoint.error).toContain("未产生代码变更");
      expect(lastTaskUpdate()).toMatchObject({ status: "paused", finishedAt: null });
      expect(mocks.runAcceptance).not.toHaveBeenCalled();
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(mocks.stage, "client/app.ts"), "utf8")).toBe(
        "export const checkout = false;\n",
      );
      expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
    });

    it("injects blocked diagnostic evidence instead of omitting its safety instructions", async () => {
      const blockedReport: RuntimeRepairEvidenceReport = {
        ...runtimeRepairReport,
        status: "blocked",
        connectivity: "blocked",
        issues: [
          "Owned running Python backend could not be verified; no diagnostic command was executed.",
        ],
      };
      mocks.collectRuntimeRepairEvidence.mockResolvedValue(blockedReport);
      mocks.run.mockResolvedValue(success);
      await execute({}, repairMessage);
      expect(mocks.run.mock.calls[0][0].prompt).toContain(JSON.stringify(blockedReport));
      expect(mocks.run.mock.calls[0][0].prompt).toContain("收费调用和配置变更需要用户确认");
      expect(await mocks.runStep.mock.results[0].value).toBe(
        "RUNTIME_REPAIR_REPORT\n" + JSON.stringify(blockedReport),
      );
      expect(checkpoint.phase).toBe("paused");
      expect(mocks.runAcceptance).not.toHaveBeenCalled();
      expect(mocks.propose).not.toHaveBeenCalled();
    });

    it("collects fresh runtime evidence on resume instead of reusing a prior report", async () => {
      mocks.collectRuntimeRepairEvidence.mockResolvedValue(runtimeRepairReport);
      mocks.run.mockResolvedValue(success);
      await execute({}, repairMessage);
      const pausedCheckpoint = checkpoint;
      const nextStep = checkpoint.nextStepIndex;
      expect(pausedCheckpoint.phase).toBe("paused");
      const refreshed: RuntimeRepairEvidenceReport = {
        ...runtimeRepairReport,
        connectivity: "connected",
        issues: ["Fresh observation after user confirmation."],
      };
      vi.clearAllMocks();
      mocks.collectRuntimeRepairEvidence.mockResolvedValue(refreshed);
      mocks.run.mockImplementation(async () => {
        await writeStage("client/app.ts", "// narrowly scoped connection handling repair\n");
        return success;
      });
      await execute({ checkpoint: pausedCheckpoint }, repairMessage);
      expect(mocks.createCheckpoint).not.toHaveBeenCalled();
      expect(mocks.collectRuntimeRepairEvidence).toHaveBeenCalledExactlyOnceWith(
        "project-fixture",
        repairMessage,
        ctrl.abort.signal,
      );
      expect(mocks.runStep.mock.calls[0].slice(1, 4)).toEqual([
        nextStep,
        "note",
        "运行故障诊断：仅观察，不重试模型",
      ]);
      expect(mocks.collectRuntimeRepairEvidence.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.createEngine.mock.invocationCallOrder[0],
      );
      expect(mocks.run.mock.calls[0][0].prompt).toContain(JSON.stringify(refreshed));
      expect(mocks.run.mock.calls[0][0].prompt).not.toContain(JSON.stringify(runtimeRepairReport));
      expect(checkpoint).toMatchObject({ attempt: 2, phase: "awaiting_acceptance" });
      expect(mocks.propose).toHaveBeenCalledTimes(1);
    });

    it("keeps runtime instructions on each engineering-check repair invocation", async () => {
      mocks.collectRuntimeRepairEvidence.mockResolvedValue(runtimeRepairReport);
      mocks.runAcceptance
        .mockResolvedValueOnce({
          status: "failed",
          checks: [
            { name: "tests", status: "failed", output: "connection handler assertion failed" },
          ],
        })
        .mockResolvedValueOnce({ status: "passed", checks: [] });
      let revision = 0;
      mocks.run.mockImplementation(async () => {
        await writeStage("client/app.ts", `// scoped repair revision ${++revision}\n`);
        return success;
      });
      await execute({}, repairMessage);
      expect(mocks.run).toHaveBeenCalledTimes(2);
      for (const [request] of mocks.run.mock.calls) {
        expect(request.prompt).toContain(JSON.stringify(runtimeRepairReport));
        expect(request.prompt).toContain("禁止自动启动模型请求、重试业务生成任务");
      }
      expect(mocks.run.mock.calls[1][0].prompt).toContain("connection handler assertion failed");
      expect(checkpoint.phase).toBe("awaiting_acceptance");
      expect(mocks.accept).not.toHaveBeenCalled();
    });

    it("pauses after eight minutes without byte progress without waiting on real timers", async () => {
      mocks.collectRuntimeRepairEvidence.mockResolvedValue(runtimeRepairReport);
      const start = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(start);
      mocks.run.mockImplementation(async () => {
        clock.mockReturnValue(start + 8 * 60_000);
        return success;
      });
      await execute({}, repairMessage);
      expect(checkpoint).toMatchObject({
        phase: "paused",
        pendingChangeSetId: null,
        error: expect.stringContaining("8分钟无文件进展"),
      });
      expect(lastTaskUpdate()).toMatchObject({ status: "paused", finishedAt: null });
      expect(mocks.runAcceptance).not.toHaveBeenCalled();
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(mocks.dispose).toHaveBeenCalledTimes(1);
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
    });

    it.each([
      ["60 distinct tool starts", 60, false, "60次工具操作"],
      ["5 identical tool starts", 5, true, "重复5次"],
    ])(
      "pauses after %s even when the engine immediately reports success",
      async (_label, count, repeated, reason) => {
        mocks.collectRuntimeRepairEvidence.mockResolvedValue(runtimeRepairReport);
        mocks.run.mockImplementation(
          async (_request: AgentEngineTask, onEvent: Parameters<AgentEngine["run"]>[1]) => {
            for (let index = 0; index < count; index++) {
              onEvent?.({
                type: "tool.started",
                runId: success.runId,
                item: {
                  type: "command_execution",
                  command: `cat client/source-${repeated ? 0 : index}.ts`,
                },
              });
            }
            return { ...success, lastMessage: "All repairs and checks passed" };
          },
        );
        await execute({}, repairMessage);
        expect(mocks.run).toHaveBeenCalledTimes(1);
        expect(checkpoint).toMatchObject({
          phase: "paused",
          pendingChangeSetId: null,
          error: expect.stringContaining(reason),
        });
        expect(lastTaskUpdate()).toMatchObject({
          status: "paused",
          finishedAt: null,
          error: expect.stringContaining(reason),
        });
        expect(mocks.runAcceptance).not.toHaveBeenCalled();
        expect(mocks.propose).not.toHaveBeenCalled();
        expect(mocks.dispose).toHaveBeenCalledTimes(1);
        expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
        expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
      },
    );
  });

  it("validates and topologically sorts a full plan, then gates every module before marking it done", async () => {
    await seedDesign();
    mocks.runAcceptance.mockResolvedValue(passedGate);
    mocks.run.mockImplementation(async (request: AgentEngineTask) => {
      if (request.prompt.includes("只规划，不实现业务代码"))
        await writeStage(".gs-codex/plan.json", JSON.stringify(modulePlan));
      else if (request.prompt.includes('本轮只实现模块：{"id":"foundation"'))
        await writeStage("foundation.ts", "export const inventory = [];\n");
      else if (request.prompt.includes('本轮只实现模块：{"id":"checkout"'))
        await writeStage("client/app.ts", "export const checkout = true;\n");
      else throw new Error("Unexpected Codex module prompt");
      return success;
    });
    await execute({ mode: "full" });
    expect(mocks.run).toHaveBeenCalledTimes(3);
    expect(mocks.createEngine).toHaveBeenCalledTimes(3);
    expect(mocks.dispose).toHaveBeenCalledTimes(3);
    // Broker renewal happens between modules, never after starting the next run.
    for (let i = 1; i < 3; i++) {
      expect(mocks.dispose.mock.invocationCallOrder[i - 1]).toBeLessThan(
        mocks.createEngine.mock.invocationCallOrder[i],
      );
      expect(mocks.createEngine.mock.invocationCallOrder[i]).toBeLessThan(
        mocks.run.mock.invocationCallOrder[i],
      );
    }
    expect(mocks.runStep.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
      [0, "note", "设计规范：specified · 视觉验收未执行"],
      [1, "code", "Codex：依据已确认需求规划功能纵切模块（含可执行冒烟）"],
      [2, "code", "Codex 模块：Foundation"],
      [3, "check", "交付闸门 · 模块 Foundation：passed"],
      [4, "code", "Codex 模块：Checkout"],
      [5, "check", "交付闸门 · 模块 Checkout：passed"],
      [6, "note", "设计规范：specified · 视觉验收未执行"],
      [7, "note", "待用户审阅：交付闸门 passed"],
    ]);
    // 每个模块一次闸门；最后一个模块的 full 闸门即最终交付结果，不重复执行。
    expect(mocks.runAcceptance).toHaveBeenCalledTimes(2);
    expect((await journal()).gates).toMatchObject({
      foundation: { status: "passed" },
      checkout: { status: "passed" },
    });
    expect((await journal()).done).toEqual(["foundation", "checkout"]);
    expect((await journal()).plan.modules.map((m: { id: string }) => m.id)).toEqual([
      "foundation",
      "checkout",
    ]);
    expect(checkpoint.requirementHash).toBe(
      createHash("sha256").update(JSON.stringify(requirement)).digest("hex"),
    );
    expect(
      mocks.propose.mock.calls[0][0].changes.map((c: { path: string }) => c.path).sort(),
    ).toEqual(["client/app.ts", "foundation.ts"]);
    expect(checkpoint.phase).toBe("awaiting_acceptance");
  });

  it("plans missing design files before module planning and proposes the real artifacts without claiming visual acceptance", async () => {
    mocks.runAcceptance.mockResolvedValue(passedGate);
    mocks.run.mockImplementation(async (request: AgentEngineTask) => {
      expectDesignPrompt(request.prompt);
      // 规划提示词同时包含设计指令（"planning：先产出"），所以先判更具体的规划标记。
      if (request.prompt.includes("只规划，不实现业务代码")) {
        expect(await fs.readFile(path.join(mocks.stage, "design-system/MASTER.md"), "utf8")).toBe(
          designFiles["MASTER.md"],
        );
        await writeStage(".gs-codex/plan.json", JSON.stringify(modulePlan));
      } else if (request.prompt.includes("planning：先产出")) {
        await expect(
          fs.stat(path.join(mocks.stage, "design-system/MASTER.md")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await seedDesign(mocks.stage);
      } else if (request.prompt.includes('本轮只实现模块：{"id":"foundation"')) {
        await writeStage("foundation.ts", "export const inventory = [];\n");
      } else if (request.prompt.includes('本轮只实现模块：{"id":"checkout"')) {
        await writeStage("client/app.ts", "export const checkout = true;\n");
      } else throw new Error("Unexpected design/module prompt");
      return success;
    });
    await execute({ mode: "full" });
    expect(mocks.run).toHaveBeenCalledTimes(4);
    expect(mocks.runStep.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ["code", "Codex：依据选题建立设计规范（不改业务代码）"],
      ["note", "设计规范：specified · 视觉验收未执行"],
      ["code", "Codex：依据已确认需求规划功能纵切模块（含可执行冒烟）"],
      ["code", "Codex 模块：Foundation"],
      ["check", "交付闸门 · 模块 Foundation：passed"],
      ["code", "Codex 模块：Checkout"],
      ["check", "交付闸门 · 模块 Checkout：passed"],
      ["note", "设计规范：specified · 视觉验收未执行"],
      ["note", "待用户审阅：交付闸门 passed"],
    ]);
    const changes = mocks.propose.mock.calls[0][0].changes;
    expect(changes.map((change: { path: string }) => change.path).sort()).toEqual([
      "client/app.ts",
      "design-system/MASTER.md",
      "design-system/pages/checkout.md",
      "design-system/tokens.json",
      "foundation.ts",
    ]);
    for (const [relative, content] of Object.entries(designFiles)) {
      expect(changes).toContainEqual({
        action: "create",
        path: `design-system/${relative}`,
        content,
      });
      await expect(fs.stat(path.join(mocks.root, "design-system", relative))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    }
    for (const index of [1, 7]) {
      const detail = await mocks.runStep.mock.results[index].value;
      expect(detail).toMatch(/^DESIGN_REPORT\n/);
      const report = JSON.parse(detail.slice("DESIGN_REPORT\n".length));
      expect(report).toMatchObject({
        status: "specified",
        issues: [],
        skills: designSkills,
        bundleRevision: "fixture-bundle-revision",
        visual: { status: "not_run", reason: "未执行真实浏览器截图视觉检查" },
      });
      expect(report.artifacts).toHaveLength(3);
      for (const artifact of report.artifacts) {
        const bytes = await fs.readFile(path.join(mocks.stage, artifact.path));
        expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
    }
    expect(mocks.propose.mock.calls[0][0].summary).toContain("设计规范：specified");
    expect(checkpoint.phase).toBe("awaiting_acceptance");
  });

  it.each(["missing", "invalid"])(
    "rejects %s design after planning even when the engine claims success",
    async (status) => {
      mocks.run.mockImplementation(async (request: AgentEngineTask) => {
        expectDesignPrompt(request.prompt);
        expect(request.prompt).toContain("planning：先产出");
        if (status === "invalid") {
          await seedDesign(mocks.stage);
          await writeStage("design-system/tokens.json", '{"version":1,"colors":{"primary":"red"}}');
        }
        return { ...success, lastMessage: "Design and visual checks passed" };
      });
      await execute({ mode: "full" });
      expect(mocks.run).toHaveBeenCalledTimes(1);
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(mocks.runAcceptance).not.toHaveBeenCalled();
      expect((await journal()).plan).toBeNull();
      expect((await journal()).done).toEqual([]);
      expect(lastTaskUpdate()).toMatchObject({
        status: "failed",
        error: expect.stringContaining("设计规范缺失或无效"),
      });
      expect(mocks.runStep.mock.calls[1][3]).toBe(`设计规范：${status} · 视觉验收未执行`);
      const report = JSON.parse(
        (await mocks.runStep.mock.results[1].value).slice("DESIGN_REPORT\n".length),
      );
      expect(report.status).toBe(status);
      expect(report.issues.length).toBeGreaterThan(0);
      expect(report.visual.status).toBe("not_run");
      expect(await fs.readFile(path.join(mocks.stage, "client/app.ts"), "utf8")).toBe(
        "export const checkout = false;\n",
      );
      expect(mocks.dispose).toHaveBeenCalledTimes(1);
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
    },
  );

  it("rejects business edits smuggled into design planning", async () => {
    mocks.run.mockImplementation(async () => {
      await seedDesign(mocks.stage);
      await writeStage("client/app.ts", "// forbidden planning implementation\n");
      return success;
    });
    await execute({ mode: "full" });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.runAcceptance).not.toHaveBeenCalled();
    expect(lastTaskUpdate()).toMatchObject({
      status: "failed",
      error: expect.stringContaining("设计前置阶段修改了设计规范之外的文件"),
    });
    expect(await fs.readFile(path.join(mocks.root, "client/app.ts"), "utf8")).toBe(
      "export const checkout = false;\n",
    );
  });

  it.each(["missing", "invalid"])(
    "rechecks %s final design and refuses a proposal after implementation",
    async (status) => {
      await seedDesign(mocks.root, true);
      mocks.run.mockImplementation(async (request: AgentEngineTask) => {
        expectDesignPrompt(request.prompt, "client/design-system");
        expect(request.prompt).toContain("仅允许修改 client/");
        await writeStage("client/app.ts", "export const checkout = true;\n");
        if (status === "missing")
          await fs.unlink(path.join(mocks.stage, "client/design-system/MASTER.md"));
        else await writeStage("client/design-system/tokens.json", "{}");
        return success;
      });
      await execute({}, "[scope:client] 设计结算页面");
      expect(mocks.run).toHaveBeenCalledTimes(1);
      expect(mocks.runAcceptance).toHaveBeenCalledTimes(1);
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(mocks.runStep.mock.calls.map((call) => call[3])).toContain(
        `设计规范：${status} · 视觉验收未执行`,
      );
      expect(lastTaskUpdate()).toMatchObject({
        status: "failed",
        error: expect.stringContaining("最终设计规范校验未通过"),
      });
      expect(
        await fs.readFile(path.join(mocks.root, "client/design-system/MASTER.md"), "utf8"),
      ).toBe(designFiles["MASTER.md"]);
    },
  );

  it("keeps the design and skill instructions in every resumed module and in-module repair invocation", async () => {
    await prepareResume("full");
    const saved = await journal();
    saved.plan = modulePlan;
    await fs.writeFile(path.join(fixture, "state/journal.json"), JSON.stringify(saved));
    mocks.runAcceptance
      .mockResolvedValueOnce({
        status: "failed",
        checks: [{ name: "tests", status: "failed", output: "real checkout failure" }],
      })
      .mockResolvedValue(passedGate);
    let runs = 0;
    mocks.run.mockImplementation(async (request: AgentEngineTask) => {
      expectDesignPrompt(request.prompt);
      runs++;
      await writeStage("client/app.ts", `// resumed revision ${runs}\n`);
      return success;
    });
    await execute({ checkpoint });
    expect(mocks.run).toHaveBeenCalledTimes(3);
    // 修复发生在 foundation 模块内部：失败的模块不会被标记完成，也不会进入下一个模块。
    expect(mocks.run.mock.calls[0][0].prompt).toContain('本轮只实现模块：{"id":"foundation"');
    expect(mocks.run.mock.calls[1][0].prompt).toContain("repair：每轮读取并尊重已有规范");
    expect(mocks.run.mock.calls[1][0].prompt).toContain("不准删测试、放宽断言");
    expect(mocks.run.mock.calls[1][0].prompt).toContain("real checkout failure");
    expect(mocks.run.mock.calls[2][0].prompt).toContain('本轮只实现模块：{"id":"checkout"');
    for (const [request] of mocks.run.mock.calls) {
      expect(request.prompt).toContain("本轮参考设计文件摘要（须实际读取，不是执行证明）");
      for (const [relative, content] of Object.entries(designFiles)) {
        expect(request.prompt).toContain(`design-system/${relative}`);
        expect(request.prompt).toContain(createHash("sha256").update(content).digest("hex"));
      }
    }
    expect(mocks.run.mock.calls[0][0].prompt).toContain("已完成模块：无");
    expect(mocks.run.mock.calls[1][0].prompt).toContain("已完成模块：无");
    expect(mocks.run.mock.calls[2][0].prompt).toContain("已完成模块：foundation");
    expect(mocks.createCheckpoint).not.toHaveBeenCalled();
    expect(mocks.runAcceptance).toHaveBeenCalledTimes(3);
    expect(checkpoint.phase).toBe("awaiting_acceptance");
    expect((await journal()).done).toEqual(["foundation", "checkout"]);
  });

  it("pauses (not fails) when a module cannot pass the gate, and resumes from the gate without regenerating", async () => {
    await seedDesign();
    mocks.runAcceptance.mockResolvedValue({
      status: "blocked",
      checks: [
        {
          name: "stack:server:gradle",
          status: "blocked",
          cause: "environment",
          output: "unsupported",
        },
      ],
    });
    mocks.run.mockImplementation(async (request: AgentEngineTask) => {
      if (request.prompt.includes("只规划，不实现业务代码"))
        await writeStage(".gs-codex/plan.json", JSON.stringify(modulePlan));
      else await writeStage("foundation.ts", "export const inventory = [];\n");
      return success;
    });
    await execute({ mode: "full" });
    // 环境类阻塞：不花模型钱修复，直接暂停。
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(lastTaskUpdate()).toMatchObject({ status: "paused", finishedAt: null });
    expect(lastTaskUpdate().error).toContain("运行环境");
    expect(mocks.propose).not.toHaveBeenCalled();
    const saved = await journal();
    expect(saved.done).toEqual([]);
    expect(saved.generated).toEqual(["foundation"]);
    // 环境修好后继续：直接从 foundation 的闸门开始，不再调用模型生成 foundation。
    vi.clearAllMocks();
    mocks.runAcceptance.mockResolvedValue(passedGate);
    mocks.run.mockImplementation(async () => {
      await writeStage("client/app.ts", "export const checkout = true;\n");
      return success;
    });
    checkpoint.phase = "paused";
    ctrl.paused = false;
    await execute({ checkpoint });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0][0].prompt).toContain('本轮只实现模块：{"id":"checkout"');
    expect((await journal()).done).toEqual(["foundation", "checkout"]);
    expect(checkpoint.phase).toBe("awaiting_acceptance");
  });

  it("does not impose a design gate on local backend maintenance with incidental page symptoms", async () => {
    await execute({}, "修复后端 API 超时导致页面报错，不修改界面");
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0][0].prompt).not.toContain("【真实设计规范与证据约束】");
    expect(mocks.runStep.mock.calls.some((call) => String(call[3]).startsWith("设计规范："))).toBe(
      false,
    );
    expect(mocks.propose).toHaveBeenCalledTimes(1);
    expect(mocks.propose.mock.calls[0][0].summary).toContain("设计规范：not_required");
    await expect(fs.stat(path.join(mocks.stage, "design-system"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(checkpoint.phase).toBe("awaiting_acceptance");
  });

  it.each([
    [
      "cyclic dependencies",
      {
        ...modulePlan,
        modules: modulePlan.modules.map((m) => ({
          ...m,
          dependsOn: m.id === "foundation" ? ["checkout"] : ["foundation"],
        })),
      },
      "循环依赖",
    ],
    [
      "missing feature coverage",
      { ...modulePlan, modules: [modulePlan.modules[1]] },
      "缺少需求覆盖",
    ],
    [
      "invented feature",
      {
        ...modulePlan,
        modules: modulePlan.modules.map((m) => ({
          ...m,
          featureIds: [...m.featureIds, "invented"],
        })),
      },
      "未知需求功能",
    ],
    [
      "unknown dependency",
      { ...modulePlan, modules: modulePlan.modules.map((m) => ({ ...m, dependsOn: ["missing"] })) },
      "未知模块依赖",
    ],
  ])(
    "rejects full plan with %s before any implementation (after one corrective retry)",
    async (_label, plan, error) => {
      await seedDesign();
      mocks.run.mockImplementation(async () => {
        await writeStage(".gs-codex/plan.json", JSON.stringify(plan));
        return success;
      });
      await execute({ mode: "full" });
      expect(mocks.run).toHaveBeenCalledTimes(2);
      expect(mocks.run.mock.calls[1][0].prompt).toContain("上一次计划未通过平台校验");
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(lastTaskUpdate()).toMatchObject({
        status: "failed",
        error: expect.stringContaining(error as string),
      });
      expect(mocks.dispose).toHaveBeenCalledTimes(2);
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
    },
  );

  it("pause abort preserves baseline, partial stage and journal, and classifies paused rather than failed", async () => {
    mocks.run.mockImplementation(async () => {
      await writeStage("client/app.ts", "// partial Codex work\n");
      ctrl.paused = true;
      ctrl.abort.abort(new Error("User requested pause"));
      return { ...success, exitCode: 130 };
    });
    await execute();
    expect(checkpoint).toMatchObject({
      phase: "paused",
      attempt: 1,
      nextStepIndex: 1,
      pendingChangeSetId: null,
      error: "User requested pause",
    });
    expect(checkpoint.baseline["client/app.ts"]).toBe("export const checkout = false;\n");
    expect(await fs.readFile(path.join(mocks.stage, "client/app.ts"), "utf8")).toBe(
      "// partial Codex work\n",
    );
    expect((await journal()).done).toEqual([]);
    expect(
      JSON.parse(await fs.readFile(path.join(fixture, "state/checkpoint.json"), "utf8")).phase,
    ).toBe("paused");
    expect(lastTaskUpdate()).toMatchObject({ status: "paused", finishedAt: null });
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
  });

  it.each(["dependencies", "acceptance"])(
    "pause abort during %s preserves stage and releases the lease without publishing",
    async (phase) => {
      const pause = async () => {
        ctrl.paused = true;
        ctrl.abort.abort(new Error(`Paused during ${phase}`));
        return phase === "dependencies"
          ? { status: "blocked", reason: "aborted" }
          : { status: "blocked", checks: [] };
      };
      if (phase === "dependencies") mocks.prepareDependencies.mockImplementation(pause);
      else mocks.runAcceptance.mockImplementation(pause);
      await execute();
      expect(checkpoint).toMatchObject({ phase: "paused", pendingChangeSetId: null });
      expect(lastTaskUpdate()).toMatchObject({
        status: "paused",
        finishedAt: null,
        error: `Paused during ${phase}`,
      });
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
      expect(await fs.readFile(path.join(mocks.stage, "README.md"), "utf8")).toBe(
        "Original project\n",
      );
      if (phase === "dependencies") {
        expect(mocks.createEngine).not.toHaveBeenCalled();
        expect(mocks.run).not.toHaveBeenCalled();
        expect(mocks.runAcceptance).not.toHaveBeenCalled();
        expect(mocks.dispose).not.toHaveBeenCalled();
      } else {
        expect(mocks.run).toHaveBeenCalledTimes(1);
        expect(mocks.dispose).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(path.join(mocks.stage, "client/app.ts"), "utf8")).toBe(
          "export const checkout = true;\n",
        );
      }
    },
  );

  it("resumes a full journal without repeating planning or completed modules", async () => {
    await prepareResume("full");
    const saved = await journal();
    saved.plan = modulePlan;
    saved.done = ["foundation"];
    await fs.writeFile(path.join(fixture, "state/journal.json"), JSON.stringify(saved));
    await writeStage("foundation.ts", "// retained completed module\n");
    checkpoint.nextStepIndex = 7;
    mocks.runAcceptance.mockResolvedValue(passedGate);
    await execute({ checkpoint });
    expect(mocks.createCheckpoint).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.runStep.mock.calls[0].slice(1, 4)).toEqual([
      7,
      "note",
      "设计规范：specified · 视觉验收未执行",
    ]);
    expect(mocks.runStep.mock.calls[1].slice(1, 4)).toEqual([8, "code", "Codex 模块：Checkout"]);
    expectDesignPrompt(mocks.run.mock.calls[0][0].prompt);
    expect((await journal()).done).toEqual(["foundation", "checkout"]);
    expect(checkpoint.phase).toBe("awaiting_acceptance");
  });

  it.each(["before resume", "during execution"])(
    "original conflict %s prevents proposals and never overwrites original",
    async (when) => {
      if (when === "before resume") {
        await prepareResume();
        await fs.writeFile(path.join(mocks.root, "client/app.ts"), "// concurrent user edit\n");
        await execute({ checkpoint });
        expect(mocks.createEngine).not.toHaveBeenCalled();
        expect(mocks.run).not.toHaveBeenCalled();
      } else {
        mocks.run.mockImplementation(async () => {
          await writeStage("client/app.ts", "// model edit\n");
          await fs.writeFile(path.join(mocks.root, "client/app.ts"), "// concurrent user edit\n");
          return success;
        });
        await execute();
        expect(mocks.dispose).toHaveBeenCalledTimes(1);
      }
      expect(await fs.readFile(path.join(mocks.root, "client/app.ts"), "utf8")).toBe(
        "// concurrent user edit\n",
      );
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(lastTaskUpdate()).toMatchObject({
        status: "failed",
        error: expect.stringContaining("拒绝覆盖"),
      });
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
    },
  );

  it("pending proposal resume never reruns Codex, recreates stage or duplicates a proposal", async () => {
    await execute();
    const before = await fs.readFile(path.join(mocks.stage, "client/app.ts"), "utf8");
    vi.clearAllMocks();
    await execute({ checkpoint });
    expect(mocks.createEngine).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.createCheckpoint).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(checkpoint.pendingChangeSetId).toBe("proposal-fixture");
    expect(await fs.readFile(path.join(mocks.stage, "client/app.ts"), "utf8")).toBe(before);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
  });

  it("preserves awaiting_acceptance when a pending checkpoint is resumed", async () => {
    await execute();
    await execute({ checkpoint });
    expect(checkpoint.phase).toBe("awaiting_acceptance");
    expect(lastTaskUpdate()).toMatchObject({ status: "paused", finishedAt: null });
  });

  it.each(["review note", "pending checkpoint", "paused task update"])(
    "preserves a published proposal and paused review state when %s persistence fails",
    async (failure) => {
      if (failure === "review note") {
        mocks.runStep.mockImplementation(async (_task, _index, kind, _title, action) => {
          if (kind === "note") throw new Error("review note unavailable");
          return action({ setChangeSet: stepChangeSet });
        });
      }
      if (failure === "pending checkpoint") {
        const persist = mocks.saveCheckpoint.getMockImplementation()!;
        let rejected = false;
        mocks.saveCheckpoint.mockImplementation(async (cp: CodexCheckpoint) => {
          if (cp.pendingChangeSetId && !rejected) {
            rejected = true;
            throw new Error("pending checkpoint unavailable");
          }
          return persist(cp);
        });
      }
      if (failure === "paused task update") {
        mocks.db.agentTask.update
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new Error("paused update unavailable"))
          .mockResolvedValue({});
      }
      await expect(execute()).resolves.toBeUndefined();
      expect(mocks.propose).toHaveBeenCalledTimes(1);
      expect(checkpoint).toMatchObject({
        phase: "awaiting_acceptance",
        pendingChangeSetId: "proposal-fixture",
      });
      expect(lastTaskUpdate()).toMatchObject({
        status: "paused",
        finishedAt: null,
        error: expect.stringContaining("unavailable"),
      });
      expect(await fs.readFile(path.join(mocks.root, "client/app.ts"), "utf8")).toBe(
        "export const checkout = false;\n",
      );
      expect(mocks.dispose).toHaveBeenCalledTimes(1);
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
      vi.clearAllMocks();
      await execute({ checkpoint });
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(mocks.db.agentTask.update).not.toHaveBeenCalled();
      expect(checkpoint.phase).toBe("awaiting_acceptance");
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
    },
  );

  it.each(["modified", "deleted", "created"])(
    "rejects original %s between initial baseline and copy before starting Codex",
    async (mutation) => {
      const actualSnapshot = await vi.importActual<
        typeof import("@/server/agents/codex-workspace")
      >("@/server/agents/codex-workspace");
      vi.mocked(snapshot).mockImplementationOnce(async (root) => {
        const baseline = await actualSnapshot.snapshot(root);
        if (mutation === "modified")
          await fs.writeFile(path.join(root, "client/app.ts"), "// concurrent baseline edit\n");
        else if (mutation === "deleted") await fs.unlink(path.join(root, "client/app.ts"));
        else await fs.writeFile(path.join(root, "new.ts"), "// concurrently created\n");
        return baseline;
      });
      await execute();
      expect(mocks.createEngine).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(checkpoint.phase).toBe("failed");
      expect(lastTaskUpdate()).toMatchObject({
        status: "failed",
        error: expect.stringContaining("创建副本期间"),
      });
      if (mutation === "modified")
        expect(await fs.readFile(path.join(mocks.root, "client/app.ts"), "utf8")).toBe(
          "// concurrent baseline edit\n",
        );
      if (mutation === "deleted")
        await expect(fs.stat(path.join(mocks.root, "client/app.ts"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      if (mutation === "created")
        expect(await fs.readFile(path.join(mocks.root, "new.ts"), "utf8")).toBe(
          "// concurrently created\n",
        );
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
    },
  );

  it("reuses an existing pending task proposal instead of creating a duplicate", async () => {
    mocks.db.changeSet.findFirst.mockResolvedValue({ id: "existing-proposal" });
    await execute();
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(stepChangeSet).toHaveBeenCalledWith("existing-proposal");
    expect(checkpoint.pendingChangeSetId).toBe("existing-proposal");
  });

  it("rejects requirement drift before engine startup and preserves the old stage/journal", async () => {
    await prepareResume("full");
    const originalJournal = await fs.readFile(path.join(fixture, "state/journal.json"), "utf8");
    const originalHash = checkpoint.requirementHash;
    mocks.db.requirement.findUnique.mockResolvedValue({
      ...requirement,
      features: [...requirement.features, { id: "feature-new", title: "New scope" }],
    });
    await execute({ checkpoint });
    expect(mocks.createEngine).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(checkpoint.requirementHash).toBe(originalHash);
    expect(await fs.readFile(path.join(fixture, "state/journal.json"), "utf8")).toBe(
      originalJournal,
    );
    expect(lastTaskUpdate()).toMatchObject({
      status: "failed",
      error: expect.stringContaining("需求范围已改变"),
    });
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
  });

  it.each(["engine throws", "nonzero exit", "proposal fails", "task persistence fails"])(
    "disposes engine and releases controller when %s",
    async (failure) => {
      if (failure === "engine throws") mocks.run.mockRejectedValue(new Error("engine exploded"));
      if (failure === "nonzero exit") mocks.run.mockResolvedValue({ ...success, exitCode: 7 });
      if (failure === "proposal fails")
        mocks.propose.mockRejectedValue(new Error("proposal unavailable"));
      if (failure === "task persistence fails")
        mocks.db.agentTask.update.mockRejectedValueOnce(new Error("write unavailable"));
      await execute();
      expect(lastTaskUpdate()).toMatchObject({ status: "failed", finishedAt: expect.any(Date) });
      expect(mocks.dispose).toHaveBeenCalledTimes(failure === "task persistence fails" ? 0 : 1);
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
      expect(await fs.stat(mocks.stage)).toMatchObject({});
      if (failure !== "proposal fails") expect(mocks.propose).not.toHaveBeenCalled();
    },
  );

  it("still releases the controller and disposes when failure checkpoint persistence also fails", async () => {
    mocks.run.mockRejectedValue(new Error("engine exploded"));
    mocks.saveCheckpoint.mockImplementation(async (cp: CodexCheckpoint) => {
      if (cp.phase === "failed") throw new Error("checkpoint disk unavailable");
    });
    await expect(execute()).resolves.toBeUndefined();
    expect(lastTaskUpdate()).toMatchObject({
      status: "failed",
      error: "engine exploded",
      finishedAt: expect.any(Date),
    });
    expect(mocks.activity).toHaveBeenCalledWith(
      "project-fixture",
      "system",
      "检查点保存失败；任务仍将停止，禁止自动继续",
    );
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
    expect(await fs.readFile(path.join(mocks.stage, "README.md"), "utf8")).toBe(
      "Original project\n",
    );
  });

  it("disposal failure cannot publish proposals and release runs even if final disposal rejects", async () => {
    mocks.dispose.mockRejectedValue(new Error("worker removal unverified"));
    await expect(execute()).rejects.toThrow("worker removal unverified");
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(lastTaskUpdate()).toMatchObject({
      status: "failed",
      error: "worker removal unverified",
    });
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(task.id);
  });
});
