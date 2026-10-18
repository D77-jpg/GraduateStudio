import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  taskUpdate: vi.fn(),
  stepCreate: vi.fn(),
  stepUpdate: vi.fn(),
  stepFind: vi.fn(),
  stepUpdateMany: vi.fn(),
  requirement: vi.fn(),
  changeFind: vi.fn(),
  exists: vi.fn(),
  read: vi.fn(),
  owner: vi.fn(),
  context: vi.fn(),
  generate: vi.fn(),
  plan: vi.fn(),
  implement: vi.fn(),
  pending: vi.fn(),
  accept: vi.fn(),
  acceptance: vi.fn(),
  investigate: vi.fn(),
  release: vi.fn(),
  register: vi.fn(),
}));
vi.mock("@/server/db", () => ({
  db: {
    agentTask: { update: m.taskUpdate },
    agentStep: {
      create: m.stepCreate,
      update: m.stepUpdate,
      findFirst: m.stepFind,
      updateMany: m.stepUpdateMany,
    },
    requirement: { findUnique: m.requirement },
    changeSet: { findFirst: m.changeFind },
  },
}));
vi.mock("@/server/ai/compat", () => ({ generateObjectCompat: m.generate }));
vi.mock("@/server/agents/coding-agent", () => ({
  generatePlan: m.plan,
  generateImplementation: m.implement,
}));
vi.mock("@/server/agents/context", () => ({
  assertProjectOwner: m.owner,
  buildCodingContext: m.context,
  renderContextForPrompt: () => "context",
}));
vi.mock("@/server/changesets", () => ({
  createPendingChangeSet: m.pending,
  acceptChangeSet: m.accept,
}));
vi.mock("@/server/workspace/paths", () => ({
  resolveProjectDir: () => "Z:/nonexistent-mocked-project",
}));
vi.mock("@/server/workspace/files", () => ({ fileExists: m.exists, readFileContent: m.read }));
vi.mock("@/server/workspace/search", () => ({
  listProjectFilePaths: () => ["package.json", "src/api/orders.ts", "src/unrelated.ts"],
  isTextFilePath: () => true,
}));
vi.mock("@/server/agents/acceptance", () => ({ runProjectAcceptance: m.acceptance }));
vi.mock("@/server/agents/investigation", () => ({ investigateAcceptanceFailure: m.investigate }));
vi.mock("@/server/agents/runner", () => ({
  gate: async () => {},
  registerTaskController: m.register,
  releaseTaskController: m.release,
  runStep: async (
    _task: unknown,
    _index: number,
    _kind: string,
    _title: string,
    fn: (ctx: { setChangeSet: () => void }) => Promise<unknown>,
  ) => fn({ setChangeSet: () => {} }),
}));
import { executeFullProjectTask, resumeFullProjectTask } from "@/server/agents/full-project";
import {
  MODULE_KINDS,
  parseFullProjectCheckpoint,
  encodeFullProjectCheckpoint,
} from "@/lib/full-project";
import type { AgentTask } from "@prisma/client";
import type { AcceptanceCheck, AcceptanceReport } from "@/lib/acceptance";

function acceptanceReport(...checks: AcceptanceCheck[]): AcceptanceReport {
  return {
    version: 1,
    status: checks.some((check) => check.status === "blocked")
      ? "blocked"
      : checks.some((check) => check.status === "failed")
        ? "failed"
        : "passed",
    checks,
    limitations: [],
  };
}
function testCheck(
  id: string,
  output: string,
  status: AcceptanceCheck["status"] = "failed",
): AcceptanceCheck {
  return {
    id,
    label: id,
    status,
    command: id === "backend-test" ? "node --test" : "vitest run",
    output,
    durationMs: 10,
  };
}
const nodeFailureOutput = (timing = 7, noise = "expected database failure") => `
✔ handles expected database failure (2ms)
Error: ${noise}
✖ returns fallback recommendations (${timing}ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  expected: 200
  actual: 500
  at TestContext.<anonymous> (backend/tests/recommendations.test.js:42:9)
✔ rejects missing token (1ms)
ℹ tests 3
ℹ pass 2
ℹ fail 1
`;
const vitestFailureOutput = (timing = 12, noise = "expected database failure") => `
 ❯ tests/feed.test.ts (2 tests | 1 failed) ${timing}ms
   × feed > loads recommendations ${timing}ms
stderr | tests/feed.test.ts > handles expected database failure
Error: ${noise}
 FAIL  tests/feed.test.ts > feed > loads recommendations
AssertionError: expected [] to have a length of 2
 ❯ tests/feed.test.ts:10:4
 Tests 1 failed | 1 passed (2)
`;
const task = {
  id: "task",
  projectId: "project",
  maxSteps: 240,
  message: "真实项目",
  startedAt: null,
} as AgentTask;
const ctrl = () => ({ paused: false, cancelled: false, abort: new AbortController() });
const modules = MODULE_KINDS.map((kind, i) => ({
  id: kind,
  kind,
  title: kind,
  featureIds: i === 1 ? ["feature"] : [],
  dependsOn: i ? [MODULE_KINDS[i - 1]] : [],
  objective: "实现真实功能",
  acceptanceCriteria: ["可测试业务闭环"],
}));
beforeEach(() => {
  vi.clearAllMocks();
  m.investigate.mockReset().mockResolvedValue({
    disposition: "repair",
    summary: "读取失败源码并验证调用契约",
    paths: [],
    observations: [],
  });
  m.exists.mockReturnValue(false);
  m.context.mockResolvedValue({
    projectText: "Java + Vue + MySQL",
    architectureText: "real database architecture",
  });
  m.requirement.mockResolvedValue({
    id: "requirement",
    updatedAt: new Date(0),
    features: [{ id: "feature", name: "业务", order: 0 }],
  });
  m.stepCreate.mockResolvedValue({ id: "checkpoint" });
  m.stepFind.mockResolvedValue(null);
  m.changeFind.mockResolvedValue(null);
  m.generate.mockResolvedValue({ title: "真实项目", modules });
  m.plan.mockImplementation(async ({ message }) => {
    const focus = message.match(/本轮仅修复检查 ([\w-]+)/)?.[1];
    const prefix = focus?.startsWith("frontend-")
      ? "client/"
      : focus === "backend-test" || focus === "backend-syntax"
        ? "backend/"
        : focus === "backend-verify" || focus === "backend-tests"
          ? "server/"
          : "";
    return {
      title: "模块计划",
      summary: "实现真实业务模块",
      risks: "",
      steps: ["a", "b", "c"].map((name) => ({
        action: "create",
        path: `${prefix}src/${name}.ts`,
        reason: "修复当前失败根因，保留业务契约",
      })),
    };
  });
  m.implement.mockImplementation(async ({ plan }) => ({
    notes: "实现",
    changes: plan.steps.map((step: object) => ({
      ...step,
      content: "export const actualValue = 42;",
    })),
  }));
  m.pending.mockResolvedValue({ id: "changeset" });
  m.accept.mockResolvedValue({
    id: "changeset",
    changes: [{ path: "src/a.ts", action: "create" }],
  });
  m.acceptance.mockResolvedValue({ status: "passed", checks: [], limitations: [] });
});
describe("mocked full orchestration without live AI or services", () => {
  it("runs every module in cost-bounded <=6-file batches, with one final acceptance and one parent", async () => {
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.plan).toHaveBeenCalledTimes(7);
    expect(m.implement).toHaveBeenCalledTimes(7);
    expect(
      m.implement.mock.calls.every(
        ([input]) => input.plan.steps.length <= 6 && input.maxOutputTokens === undefined,
      ),
    ).toBe(true);
    expect(m.plan.mock.calls.every(([input]) => input.moduleScoped === true)).toBe(true);
    expect(m.acceptance).toHaveBeenCalledTimes(1);
    expect(m.taskUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
    );
    const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(final.completedModuleIds).toHaveLength(7);
    expect(final.modelCalls).toBe(15);
    expect(final.executionStats?.modelCalls).toBe(15);
    expect(final.executionStats?.steps).toBeGreaterThan(0);
    expect(final.activeSince).toBeNull();
  });
  it("resumes a crashed accepted batch without regenerating it or completed modules", async () => {
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    cp.phase = "modules";
    cp.completedModuleIds = ["foundation"];
    cp.currentModule = modules[1];
    cp.currentPlan = {
      title: "业务计划",
      summary: "实现真实数据库业务",
      risks: "",
      steps: [{ action: "create", path: "src/resume.ts", reason: "业务" }],
    };
    cp.batchCursor = 0;
    cp.pendingChangeSetId = "already-applied";
    cp.appliedChangeSetIds = [];
    cp.activeSince = null;
    m.plan.mockClear();
    m.implement.mockClear();
    m.accept.mockClear();
    m.generate.mockClear();
    m.exists.mockReturnValue(true);
    m.read.mockReturnValue({ content: "export const actualValue = 42;" });
    m.changeFind.mockImplementation(async ({ where }) =>
      where.id === "already-applied"
        ? {
            id: "already-applied",
            status: "accepted",
            changes: [
              {
                path: "src/resume.ts",
                action: "create",
                beforeContent: null,
                afterContent: "export const actualValue = 42;",
              },
            ],
          }
        : null,
    );
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl(), {
      id: "checkpoint",
      checkpoint: cp,
    });
    expect(m.generate).not.toHaveBeenCalled();
    expect(m.plan).toHaveBeenCalledTimes(5);
    expect(m.implement).toHaveBeenCalledTimes(5);
    expect(m.accept).not.toHaveBeenCalledWith("already-applied", "user");
    expect(cp.completedModuleIds).toHaveLength(7);
    expect(cp.appliedChangeSetIds).toContain("already-applied");
  });
  it.each([false, true])(
    "resumes the snapshotted file plan and %s dynamic layout without regenerating or revising boundaries",
    async (dynamic) => {
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
      const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
      cp.phase = "modules";
      cp.completedModuleIds = modules
        .filter((module) => module.id !== "business")
        .map((module) => module.id);
      cp.currentModule = modules[1];
      cp.appliedChangeSetIds = [];
      cp.pendingChangeSetId = null;
      cp.currentPlan = {
        title: "快照",
        summary: "持久化文件职责",
        risks: "",
        steps: Array.from({ length: 5 }, (_, i) => ({
          action: "create",
          path: `src/snapshot${i}.ts`,
          reason: "快照职责",
        })),
      };
      cp.batchCursor = 1;
      if (dynamic) cp.generationBatches = [[0], [1, 2, 3], [4]];
      else delete cp.generationBatches;
      m.plan.mockClear();
      m.implement.mockClear();
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl(), {
        id: "checkpoint",
        checkpoint: cp,
      });
      expect(m.plan).not.toHaveBeenCalled();
      expect(
        m.implement.mock.calls.map(([input]) =>
          input.plan.steps.map((step: { path: string }) => step.path),
        ),
      ).toEqual(
        dynamic
          ? [["src/snapshot1.ts", "src/snapshot2.ts", "src/snapshot3.ts"], ["src/snapshot4.ts"]]
          : [["src/snapshot2.ts", "src/snapshot3.ts"], ["src/snapshot4.ts"]],
      );
      expect(cp.phase).toBe("completed");
    },
  );
  it("isolates a large modification using workspace length and persists boundaries before implementation", async () => {
    m.read.mockReturnValue({ content: "x".repeat(30_000), truncated: false });
    m.plan.mockResolvedValue({
      title: "模块计划",
      summary: "真实业务模块",
      risks: "",
      steps: [
        { action: "create", path: "src/small.ts", reason: "基础" },
        { action: "modify", path: "src/large.ts", reason: "保留完整业务" },
        { action: "create", path: "src/tail.ts", reason: "接入" },
      ],
    });
    let checked = false;
    m.implement.mockImplementation(async ({ plan }) => {
      const saved = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
      expect(saved.currentPlan?.steps).toHaveLength(3);
      expect(saved.generationBatches).toEqual([[0], [1], [2]]);
      if (plan.steps[0].path === "src/large.ts") {
        expect(plan.steps).toHaveLength(1);
        checked = true;
      }
      return {
        notes: "真实实现",
        changes: plan.steps.map((step: object) => ({
          ...step,
          content: "export const actualValue = 42;",
        })),
      };
    });
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(checked).toBe(true);
    expect(m.implement).toHaveBeenCalledTimes(21);
  });
  it.each([false, true])(
    "continues without allowance mutation (legacy extend=%s)",
    async (extendBudget) => {
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
      const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
      cp.phase = "blocked";
      cp.activeSince = null;
      cp.elapsedMs = 1_000_000_000;
      cp.modelCalls = 1_000_000;
      cp.nextStepIndex = 1_000_000;
      cp.appliedChangeSetIds = [];
      m.stepFind.mockResolvedValue({ id: "checkpoint", detail: encodeFullProjectCheckpoint(cp) });
      m.register.mockReturnValue(ctrl());
      const finished = new Promise<void>((resolve) => {
        m.release.mockImplementationOnce(() => resolve());
      });
      expect(await resumeFullProjectTask(task, "project", "user", { extendBudget })).toBe(true);
      await finished;
      const written = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
      expect(written.phase).toBe("completed");
      expect(written.elapsedMs).toBeGreaterThanOrEqual(1_000_000_000);
      expect(written.budgetExtensions).toBeUndefined();
      expect(written.maxSteps).toBe(240);
    },
  );
  it.each(["json", "schema", "length"])(
    "splits typed implementation %s failures progressively before any writes",
    async (kind) => {
      const failure = Object.assign(new Error("AI 输出格式错误"), {
        name: "AiOutputFormatError",
        kind,
      });
      m.implement.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
      expect(m.implement.mock.calls.slice(0, 3).map(([input]) => input.plan.steps.length)).toEqual([
        3, 2, 1,
      ]);
      expect(m.pending.mock.calls[0][0].title).toBe("FULL_PROJECT_BATCH:task:foundation:files-0");
      expect(m.pending.mock.invocationCallOrder[0]).toBeGreaterThan(
        m.implement.mock.invocationCallOrder[2],
      );
      expect(m.taskUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
      );
    },
  );
  it("never splits untyped runtime output messages or network errors", async () => {
    m.implement.mockRejectedValueOnce(
      new Error("AI 调用失败:AI 输出JSON Schema 校验失败: network failure"),
    );
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.implement).toHaveBeenCalledTimes(1);
    expect(m.pending).not.toHaveBeenCalled();
    const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(cp.batchRecovery).toBeUndefined();
    expect(cp.generationBatches).toEqual([[0, 1, 2]]);
  });
  it("stops single-file JSON failure after one attempt with a precise no-writes diagnostic", async () => {
    m.plan.mockResolvedValue({
      title: "单文件",
      summary: "实现真实业务模块",
      risks: "",
      steps: [{ action: "create", path: "src/one.ts", reason: "业务" }],
    });
    m.implement.mockRejectedValueOnce(
      Object.assign(new Error("AI 输出未找到可解析的完整 JSON 对象"), {
        name: "AiOutputFormatError",
        kind: "json",
      }),
    );
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.implement).toHaveBeenCalledTimes(1);
    expect(m.pending).not.toHaveBeenCalled();
    expect(m.accept).not.toHaveBeenCalled();
    const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(cp.error).toContain("单文件生成JSON 输出不完整或无法解析");
    expect(cp.error).toContain("未创建或应用本批次变更");
    expect(cp.error).not.toContain("超时");
  });
  it("splits typed implementation timeout before writes and persists noncolliding slice identities", async () => {
    const timeout = Object.assign(new Error("request timeout"), { name: "AiRequestTimeoutError" });
    m.implement.mockRejectedValueOnce(timeout);
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.implement.mock.calls.slice(0, 3).map(([input]) => input.plan.steps.length)).toEqual([
      3, 2, 1,
    ]);
    expect(m.pending.mock.calls[0][0].title).toBe("FULL_PROJECT_BATCH:task:foundation:files-0-1");
    const snapshots = m.stepUpdate.mock.calls.map(([input]) =>
      parseFullProjectCheckpoint(input.data.detail),
    );
    expect(
      snapshots.some(
        (cp) => cp?.generationBatches?.map((batch) => batch.join()).join(";") === "0,1;2",
      ),
    ).toBe(true);
  });
  it.each([false, true])(
    "recovers legacy recorded timeout before repeating a request, existing accepted=%s",
    async (accepted) => {
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
      const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
      cp.phase = "blocked";
      cp.error = "AI 生成超时,请稍后重试";
      cp.currentModule = modules[1];
      cp.completedModuleIds = modules
        .filter((module) => module.id !== "business")
        .map((module) => module.id);
      cp.currentPlan = {
        title: "恢复计划",
        summary: "恢复真实业务模块",
        risks: "",
        steps: Array.from({ length: 5 }, (_, i) => ({
          action: "create" as const,
          path: `src/recover${i}.ts`,
          reason: "业务",
        })),
      };
      cp.appliedChangeSetIds = [];
      cp.batchCursor = 1;
      delete cp.generationBatches;
      delete cp.generationBatchKeys;
      m.implement.mockClear();
      m.pending.mockClear();
      m.changeFind.mockImplementation(async ({ where }) =>
        accepted && where.title === "FULL_PROJECT_BATCH:task:business:1"
          ? { id: "old-accepted", status: "accepted", changes: [] }
          : null,
      );
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl(), {
        id: "checkpoint",
        checkpoint: cp,
      });
      expect(
        m.implement.mock.calls.map(([input]) =>
          input.plan.steps.map((file: { path: string }) => file.path),
        ),
      ).toEqual(
        accepted
          ? [["src/recover4.ts"]]
          : [["src/recover2.ts"], ["src/recover3.ts"], ["src/recover4.ts"]],
      );
      if (!accepted)
        expect(m.pending.mock.calls.map(([input]) => input.title)).toEqual([
          "FULL_PROJECT_BATCH:task:business:files-2",
          "FULL_PROJECT_BATCH:task:business:files-3",
          "FULL_PROJECT_BATCH:task:business:files-4",
        ]);
    },
  );
  it.each([false, true])(
    "recovers historical JSON with a 14-file plan and preserves accepted legacy identity (%s)",
    async (accepted) => {
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
      const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
      cp.phase = "blocked";
      cp.error = "AI 调用失败:AI 输出未找到可解析的完整 JSON 对象（finishReason=stop）";
      cp.currentModule = modules[1];
      cp.completedModuleIds = modules
        .filter((module) => module.id !== "business")
        .map((module) => module.id);
      cp.currentPlan = {
        title: "历史快照",
        summary: "实现真实业务模块",
        risks: "",
        steps: Array.from({ length: 14 }, (_, i) => ({
          action: "create" as const,
          path: `src/history${i}.ts`,
          reason: "业务",
        })),
      };
      cp.appliedChangeSetIds = [];
      cp.batchCursor = 0;
      cp.generationBatches = [
        [0, 1, 2, 3, 4, 5],
        [6, 7, 8, 9, 10, 11],
        [12, 13],
      ];
      delete cp.generationBatchKeys;
      m.implement.mockClear();
      m.plan.mockClear();
      m.pending.mockClear();
      m.accept.mockClear();
      m.changeFind.mockImplementation(async ({ where }) =>
        accepted && where.title === "FULL_PROJECT_BATCH:task:business:0"
          ? { id: "old-accepted", status: "accepted", changes: [] }
          : null,
      );
      const success = async ({ plan }: { plan: { steps: object[] } }) => ({
        notes: "实现",
        changes: plan.steps.map((step) => ({ ...step, content: "export const actualValue = 42;" })),
      });
      m.implement.mockImplementation(async (input) => {
        if (input.plan.steps.length > 1)
          throw Object.assign(new Error("bad JSON"), { name: "AiOutputFormatError", kind: "json" });
        return success(input);
      });
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl(), {
        id: "checkpoint",
        checkpoint: cp,
      });
      expect(m.plan).not.toHaveBeenCalled();
      expect(cp.phase).toBe("completed");
      expect(m.pending.mock.calls).toHaveLength(accepted ? 8 : 14);
      if (accepted) {
        expect(cp.appliedChangeSetIds).toContain("old-accepted");
        expect(m.accept).not.toHaveBeenCalledWith("old-accepted", "user");
        expect(m.implement.mock.calls[0][0].plan.steps[0].path).toBe("src/history6.ts");
      } else {
        expect(
          m.implement.mock.calls.slice(0, 3).map(([input]) => input.plan.steps.length),
        ).toEqual([3, 2, 1]);
        expect(m.pending.mock.calls[0][0].title).toBe("FULL_PROJECT_BATCH:task:business:files-0");
      }
      const titles = m.pending.mock.calls.map(([input]) => input.title);
      expect(new Set(titles).size).toBe(titles.length);
    },
  );
  it("does not split a new implementation plan after historical module-plan schema failure", async () => {
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    cp.phase = "blocked";
    cp.error = "AI 调用失败:AI 输出JSON Schema 校验失败（2 项问题）";
    cp.currentModule = modules[1];
    cp.currentPlan = null;
    cp.completedModuleIds = modules
      .filter((module) => module.id !== "business")
      .map((module) => module.id);
    cp.appliedChangeSetIds = [];
    m.implement.mockClear();
    m.plan.mockClear();
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl(), {
      id: "checkpoint",
      checkpoint: cp,
    });
    expect(m.plan).toHaveBeenCalledTimes(1);
    expect(m.implement).toHaveBeenCalledTimes(1);
    expect(m.implement.mock.calls[0][0].plan.steps).toHaveLength(3);
    expect(cp.phase).toBe("completed");
  });
  it("single-file timeout stops without pending writes or infinite retries", async () => {
    m.plan.mockResolvedValue({
      title: "单文件",
      summary: "实现真实单文件业务",
      risks: "",
      steps: [{ action: "create", path: "src/one.ts", reason: "业务" }],
    });
    m.implement.mockRejectedValueOnce(
      Object.assign(new Error("timeout"), { name: "AiRequestTimeoutError" }),
    );
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.implement).toHaveBeenCalledTimes(1);
    expect(m.pending).not.toHaveBeenCalled();
    expect(m.accept).not.toHaveBeenCalled();
    const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(cp.error).toContain("单文件");
  });
  it("never splits after generation when changeset creation or acceptance times out", async () => {
    m.pending.mockRejectedValueOnce(
      Object.assign(new Error("disk timeout"), { name: "TimeoutError" }),
    );
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.implement).toHaveBeenCalledTimes(1);
    expect(m.accept).not.toHaveBeenCalled();
    const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(cp.generationBatches).toEqual([[0, 1, 2]]);
    expect(cp.batchRecovery).toBeUndefined();
  });
  it("counts actual callback attempts not facades and checks budget before each request", async () => {
    m.generate.mockImplementationOnce(async (input) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const event = {
          provider: "deepseek",
          model: "test-model",
          requestedBudget: 8000,
          attempt,
          durationMs: 0,
          textChars: 0,
          reasoningChars: 0,
        };
        await input.onRequestEvent({ ...event, type: "started" });
        await input.onRequestEvent({ ...event, type: "completed" });
      }
      return { title: "真实项目", modules };
    });
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(cp.modelCalls).toBe(16);
    expect(cp.actualRequests).toBe(2);
    expect(cp.executionStats?.modelCalls).toBe(15);
    expect(cp.lastRequest?.type).toBe("completed");
  });
  it("continues actual requests far beyond legacy usage limits without a wall timer", async () => {
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    cp.phase = "planning";
    cp.plan = null;
    cp.completedModuleIds = [];
    cp.modelCalls = 1_000_000;
    cp.elapsedMs = 1_000_000_000;
    cp.nextStepIndex = 1_000_000;
    cp.maxSteps = 1;
    cp.maxWallMs = 1;
    cp.maxModelCalls = 1;
    const timer = vi.spyOn(globalThis, "setTimeout");
    cp.appliedChangeSetIds = [];
    m.plan.mockClear();
    let transports = 0;
    m.generate.mockImplementationOnce(async (input) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await input.onRequestEvent({
          type: "started",
          provider: "deepseek",
          model: "safe",
          requestedBudget: 8000,
          attempt,
          durationMs: 0,
          textChars: 0,
          reasoningChars: 0,
        });
        transports++;
      }
      return { title: "真实项目", modules };
    });
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl(), {
      id: "checkpoint",
      checkpoint: cp,
    });
    expect(transports).toBe(2);
    expect(cp.modelCalls).toBe(1_000_016);
    expect(cp.actualRequests).toBe(2);
    expect(cp.phase).toBe("completed");
    expect(cp.error).toBeNull();
    expect(m.plan).toHaveBeenCalledTimes(7);
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
  });
  it("records live timing even when model generation throws", async () => {
    m.plan.mockRejectedValueOnce(new Error("generation timeout"));
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(cp.executionStats?.modelCalls).toBe(2);
    expect(cp.executionStats?.lastModelMs).toBeGreaterThanOrEqual(0);
    expect(cp.phase).toBe("blocked");
  });
  it("rejects changed feature scope without relying on parent updatedAt", async () => {
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    cp.phase = "blocked";
    m.requirement.mockResolvedValue({
      id: "requirement",
      updatedAt: new Date(0),
      features: [{ id: "feature", name: "Changed business", order: 0 }],
    });
    m.generate.mockClear();
    m.plan.mockClear();
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl(), {
      id: "checkpoint",
      checkpoint: cp,
    });
    expect(m.plan).not.toHaveBeenCalled();
    expect(cp.error).toContain("需求已变更");
  });
  it("checks last-write contents of previously completed modules on recovery", async () => {
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    cp.phase = "blocked";
    cp.appliedChangeSetIds = ["old", "latest"];
    m.changeFind.mockImplementation(async ({ where }) => ({
      id: where.id,
      status: "accepted",
      changes: [
        { path: "src/a.ts", action: "modify", afterContent: where.id === "old" ? "old" : "latest" },
      ],
    }));
    m.exists.mockReturnValue(true);
    m.read.mockReturnValue({ content: "external change" });
    m.plan.mockClear();
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl(), {
      id: "checkpoint",
      checkpoint: cp,
    });
    expect(m.plan).not.toHaveBeenCalled();
    expect(cp.error).toContain("已完成模块文件");
  });
  it("honors cancellation arriving while the final completed checkpoint is persisted", async () => {
    const control = ctrl();
    m.stepUpdate.mockImplementation(async ({ data }) => {
      if (parseFullProjectCheckpoint(data.detail ?? "")?.phase === "completed") {
        control.cancelled = true;
        control.abort.abort();
      }
    });
    await executeFullProjectTask(task, "project", "user", task.message, 240, control);
    expect(m.taskUpdate.mock.calls.some(([input]) => input.data.status === "completed")).toBe(
      false,
    );
    expect(m.taskUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) }),
    );
    m.stepUpdate.mockReset();
  });
  it("stops on blocked acceptance without wasted repair calls or fake completion", async () => {
    m.acceptance.mockResolvedValue({
      status: "blocked",
      checks: [{ status: "blocked", output: "missing Maven" }],
    });
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.plan).toHaveBeenCalledTimes(7);
    expect(m.taskUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("missing Maven"),
        }),
      }),
    );
  });
  it("fails missing requirements before any model or implementation calls", async () => {
    m.requirement.mockResolvedValue(null);
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.generate).not.toHaveBeenCalled();
    expect(m.plan).not.toHaveBeenCalled();
    expect(m.release).toHaveBeenCalledWith("task");
  });
  it.each([
    { id: "frontend-build", output: "build failed; see earlier logs" },
    { id: "backend-test", output: "ℹ tests 3\nℹ pass 2\nℹ fail 1" },
    { id: "frontend-test", output: "Tests 2 failed | 8 passed (10)" },
  ])(
    "does not spend repair AI calls when $id lacks actionable failure evidence",
    async ({ id, output }) => {
      const report = acceptanceReport(testCheck(id, output));
      m.acceptance.mockResolvedValueOnce(report).mockResolvedValue(report);
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
      expect(m.acceptance).toHaveBeenCalledTimes(2);
      expect(m.acceptance.mock.calls.map(([, options]) => options.onlyCheckIds)).toEqual([
        undefined,
        [id],
      ]);
      expect(m.plan).toHaveBeenCalledTimes(7);
      expect(m.implement).toHaveBeenCalledTimes(7);
      expect(m.pending).toHaveBeenCalledTimes(7);
      const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
      expect(final.phase).toBe("blocked");
      expect(final.repairAttempts).toBe(0);
      expect(final.error).toContain("缺少完整失败证据");
      expect(JSON.parse(final.acceptanceReport!)).toEqual(report);
      expect(m.taskUpdate.mock.calls.some(([input]) => input.data.status === "completed")).toBe(
        false,
      );
    },
  );

  it("automatically recaptures missing backend evidence before planning or writing a focused repair", async () => {
    const passedFrontend = testCheck("frontend-build", "build passed", "passed");
    const initial = acceptanceReport(
      testCheck("backend-test", "ℹ tests 3\nℹ pass 2\nℹ fail 1"),
      passedFrontend,
    );
    const recoveredCheck = testCheck(
      "backend-test",
      "Error: Cannot find module './recommendations.js' imported from backend/tests/recommendations.test.js",
    );
    const recovered = acceptanceReport(recoveredCheck);
    const merged = acceptanceReport(recoveredCheck, passedFrontend);
    m.acceptance
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(recovered)
      .mockResolvedValue(
        acceptanceReport(testCheck("backend-test", "all tests passed", "passed"), passedFrontend),
      );
    const usualPlan = m.plan.getMockImplementation()!;
    m.plan.mockImplementation(async (input) => {
      if (input.message.includes("本轮仅修复检查")) {
        expect(m.acceptance).toHaveBeenCalledTimes(2);
        const saved = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
        expect(JSON.parse(saved.acceptanceReport!)).toEqual(merged);
        expect(JSON.parse(saved.repairBaselineReport!)).toEqual(merged);
        expect(input.message).toContain("Cannot find module");
        expect(m.pending).toHaveBeenCalledTimes(7);
      }
      return usualPlan(input);
    });
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.acceptance.mock.calls.map(([, options]) => options.onlyCheckIds)).toEqual([
      undefined,
      ["backend-test"],
      ["backend-test"],
      undefined,
    ]);
    expect(m.plan).toHaveBeenCalledTimes(8);
    expect(m.implement).toHaveBeenCalledTimes(8);
    expect(m.pending.mock.invocationCallOrder[7]).toBeGreaterThan(
      m.acceptance.mock.invocationCallOrder[1],
    );
    const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(final.phase).toBe("completed");
    expect(final.repairAttempts).toBe(1);
    expect(JSON.parse(final.repairBaselineReport!)).toEqual(merged);
  });

  it("continues grounded repair after full-suite timeout without marking timeout passed", async () => {
    const blocked = acceptanceReport(
      testCheck("backend-test", "命令超过 120000ms 执行时限。", "blocked"),
    );
    const passed = acceptanceReport(testCheck("backend-test", "tests passed", "passed"));
    m.acceptance.mockResolvedValueOnce(blocked).mockResolvedValue(passed);
    m.investigate.mockResolvedValue({
      disposition: "repair",
      summary: "confirmed assertion",
      paths: ["backend/tests/app.test.js"],
      observations: [
        {
          request: { tool: "node_test", directory: "backend" },
          result: { exitCode: 1, output: nodeFailureOutput(), truncated: false },
        },
      ],
    });
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.investigate).toHaveBeenCalledTimes(1);
    expect(m.plan).toHaveBeenCalledTimes(8);
    expect(m.acceptance.mock.calls.map(([, o]) => o.onlyCheckIds)).toEqual([
      undefined,
      ["backend-test"],
      undefined,
    ]);
    const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(final.phase).toBe("completed");
    expect(final.repairAttempts).toBe(1);
  });
  it("recaptured environment blockers preserve passed checks and stop without repair AI", async () => {
    const passedFrontend = testCheck("frontend-build", "build passed", "passed");
    const initial = acceptanceReport(testCheck("backend-test", "ℹ fail 1"), passedFrontend);
    const blockedCheck = testCheck(
      "backend-test",
      "Required tool node unavailable: command not found",
      "blocked",
    );
    m.acceptance
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(acceptanceReport(blockedCheck));
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.acceptance.mock.calls.map(([, options]) => options.onlyCheckIds)).toEqual([
      undefined,
      ["backend-test"],
    ]);
    expect(m.plan).toHaveBeenCalledTimes(7);
    expect(m.implement).toHaveBeenCalledTimes(7);
    expect(m.pending).toHaveBeenCalledTimes(7);
    const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(final.phase).toBe("blocked");
    expect(final.repairAttempts).toBe(0);
    expect(JSON.parse(final.acceptanceReport!)).toEqual(
      acceptanceReport(blockedCheck, passedFrontend),
    );
    expect(final.error).toContain("command not found");
    expect(m.taskUpdate.mock.calls.some(([input]) => input.data.status === "completed")).toBe(
      false,
    );
  });

  it("keeps repairing changing failures beyond two attempts until real acceptance passes", async () => {
    let checks = 0;
    m.acceptance.mockImplementation(async (_dir, options) => {
      if (options.onlyCheckIds)
        return acceptanceReport(testCheck("frontend-build", "build passed", "passed"));
      checks++;
      return checks <= 5
        ? {
            status: "failed",
            checks: [
              {
                id: "frontend-build",
                status: "failed",
                output: `Error: reproducible root failure ${checks}`,
                durationMs: checks,
              },
            ],
          }
        : { status: "passed", checks: [], limitations: [] };
    });
    await executeFullProjectTask(task, "project", "user", task.message, 1, ctrl());
    const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(final.phase).toBe("completed");
    expect(final.repairAttempts).toBe(5);
    expect(final.maxSteps).toBe(1);
    expect(final.nextStepIndex).toBeGreaterThan(1);
    expect(m.plan).toHaveBeenCalledTimes(12);
    expect(m.acceptance).toHaveBeenCalledTimes(11);
    expect(m.acceptance.mock.calls.filter(([, options]) => options.onlyCheckIds)).toHaveLength(5);
  });
  it("stops repeated identical failure after attempted repair and retains report", async () => {
    m.acceptance.mockResolvedValue({
      status: "failed",
      checks: [
        {
          id: "frontend-build",
          label: "前端构建",
          status: "failed",
          output: "Error: actual build failure",
        },
      ],
    });
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.plan).toHaveBeenCalledTimes(8);
    expect(m.acceptance).toHaveBeenCalledTimes(2);
    const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(final.phase).toBe("blocked");
    expect(final.repairAttempts).toBe(1);
    expect(final.error).toContain("未取得进展");
    expect(final.acceptanceReport).toContain("actual build failure");
  });

  it.each(["backend-test", "frontend-test"])(
    "rejects a broad %s repair plan before implementation or writes",
    async (focus) => {
      const baseline = acceptanceReport(
        testCheck(focus, focus === "backend-test" ? nodeFailureOutput() : vitestFailureOutput()),
      );
      m.acceptance.mockResolvedValue(baseline);
      const normalPlan = m.plan.getMockImplementation()!;
      m.plan.mockImplementation(async (input) =>
        input.message.includes("本轮仅修复检查")
          ? {
              title: "不相关的全工程重写",
              summary: "重写整个工程",
              risks: "",
              steps: [{ action: "modify", path: "src/unrelated.ts", reason: "重写其他模块" }],
            }
          : normalPlan(input),
      );
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
      expect(m.plan).toHaveBeenCalledTimes(8);
      expect(m.implement).toHaveBeenCalledTimes(7);
      expect(m.pending).toHaveBeenCalledTimes(7);
      expect(m.accept).toHaveBeenCalledTimes(7);
      expect(m.acceptance).toHaveBeenCalledTimes(1);
      const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
      expect(final.phase).toBe("blocked");
      expect(final.error).toContain("范围");
      expect(final.repairFocusCheckId).toBe(focus);
      expect(JSON.parse(final.repairBaselineReport!)).toEqual(baseline);
      expect(final.currentPlan).toBeNull();
    },
  );

  it("investigates before planning a repair and persists its grounded conclusion", async () => {
    m.acceptance.mockResolvedValue(
      acceptanceReport(testCheck("backend-test", nodeFailureOutput())),
    );
    m.investigate.mockResolvedValue({
      disposition: "insufficient",
      summary: "need more source evidence",
      paths: [],
      observations: [],
    });
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.investigate).toHaveBeenCalledTimes(1);
    expect(m.plan).toHaveBeenCalledTimes(7);
    const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(final.investigation?.disposition).toBe("insufficient");
    expect(final.repairAttempts).toBe(0);
  });
  it("persists one focused repair baseline, then requires full acceptance after targeted success", async () => {
    const baseline = acceptanceReport(
      testCheck("backend-test", nodeFailureOutput()),
      testCheck("frontend-test", vitestFailureOutput()),
    );
    m.acceptance
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(
        acceptanceReport(testCheck("frontend-test", "Tests 2 passed (2)", "passed")),
      )
      .mockResolvedValueOnce(acceptanceReport(testCheck("backend-test", nodeFailureOutput())));
    const focusedPlan = m.plan.getMockImplementation()!;
    m.plan.mockImplementation(async (input) => {
      if (input.message.includes("本轮仅修复检查 backend-test"))
        throw new Error("stop after observing second focused plan");
      return focusedPlan(input);
    });
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.acceptance.mock.calls.slice(0, 3).map(([, options]) => options.onlyCheckIds)).toEqual([
      undefined,
      ["frontend-test"],
      undefined,
    ]);
    const repairInput = m.plan.mock.calls[7][0];
    expect(repairInput.message).toContain("本轮仅修复检查 frontend-test");
    const beforeRepair = m.stepUpdate.mock.calls
      .filter(([input]) => input.data.detail?.startsWith("FULL_PROJECT_CHECKPOINT"))
      .map(([input]) => parseFullProjectCheckpoint(input.data.detail)!)
      .find((cp) => cp.currentModule?.id === "repair-1" && cp.currentPlan !== null)!;
    expect(beforeRepair.repairFocusCheckId).toBe("frontend-test");
    expect(JSON.parse(beforeRepair.repairBaselineReport!)).toEqual(baseline);
    // The remaining backend failure requires another repair, not early completion.
    expect(m.plan.mock.calls[8][0].message).toContain("本轮仅修复检查 backend-test");
    expect(m.taskUpdate.mock.calls.some(([input]) => input.data.status === "completed")).toBe(
      false,
    );
  });

  it("targeted pass never completes when the subsequent full acceptance is blocked", async () => {
    const baseline = acceptanceReport(testCheck("backend-test", nodeFailureOutput()));
    m.acceptance
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(
        acceptanceReport(testCheck("backend-test", "all tests passed", "passed")),
      )
      .mockResolvedValueOnce(
        acceptanceReport(testCheck("frontend-build", "missing Maven", "blocked")),
      );
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.acceptance.mock.calls.map(([, options]) => options.onlyCheckIds)).toEqual([
      undefined,
      ["backend-test"],
      undefined,
    ]);
    const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(final.phase).toBe("blocked");
    expect(final.acceptanceReport).toContain("missing Maven");
    expect(m.taskUpdate.mock.calls.some(([input]) => input.data.status === "completed")).toBe(
      false,
    );
  });

  it.each(["failed", "blocked"] as const)(
    "stops when full regression makes a previously passed check %s, without a second repair",
    async (status) => {
      const baseline = acceptanceReport(
        testCheck("backend-test", nodeFailureOutput()),
        testCheck("frontend-build", "build passed", "passed"),
      );
      const regression = testCheck(
        "frontend-build",
        status === "failed"
          ? "Error: missing named export from src/App.tsx"
          : "构建脚本缺失或无法识别；仅支持标准 Vite/Next/React/Vue 构建，不执行未知或空操作脚本。",
        status,
      );
      m.acceptance
        .mockResolvedValueOnce(baseline)
        .mockResolvedValueOnce(
          acceptanceReport(testCheck("backend-test", "all tests passed", "passed")),
        )
        .mockResolvedValueOnce(
          acceptanceReport(testCheck("backend-test", "all tests passed", "passed"), regression),
        );
      // A repairable metadata blocker without a command is recaptured once too.
      if (status === "blocked") m.acceptance.mockResolvedValueOnce(acceptanceReport(regression));
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
      expect(m.acceptance).toHaveBeenCalledTimes(status === "blocked" ? 4 : 3);
      if (status === "blocked")
        expect(m.acceptance.mock.calls[3][1].onlyCheckIds).toEqual(["frontend-build"]);
      expect(m.plan).toHaveBeenCalledTimes(8);
      expect(m.implement).toHaveBeenCalledTimes(8);
      const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
      expect(final.phase).toBe("blocked");
      expect(final.repairAttempts).toBe(1);
      expect(final.error).toContain("回退");
      expect(final.error).toContain("frontend-build");
      expect(JSON.parse(final.acceptanceReport!).checks).toContainEqual(regression);
    },
  );

  it.each(["backend-test", "frontend-test"])(
    "stops unchanged named %s failures despite changed timings and ordinary error logs",
    async (focus) => {
      const output = focus === "backend-test" ? nodeFailureOutput : vitestFailureOutput;
      const baseline = acceptanceReport(testCheck(focus, output(7, "expected database failure")));
      const unchanged = acceptanceReport({
        ...testCheck(focus, output(989, "new expected warning/cache noise")),
        durationMs: 9999,
      });
      expect(unchanged.checks[0].output).not.toBe(baseline.checks[0].output);
      m.acceptance.mockResolvedValueOnce(baseline).mockResolvedValue(unchanged);
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
      expect(m.acceptance).toHaveBeenCalledTimes(2);
      expect(m.acceptance.mock.calls[1][1].onlyCheckIds).toEqual([focus]);
      expect(m.stepUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { detail: `ACCEPTANCE_REPORT\n${JSON.stringify(unchanged)}` },
        }),
      );
      expect(m.plan).toHaveBeenCalledTimes(8);
      const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
      expect(final.phase).toBe("blocked");
      expect(final.error).toContain("未取得进展");
      expect(final.repairAttempts).toBe(1);
      expect(JSON.parse(final.repairBaselineReport!)).toEqual(baseline);
    },
  );

  it("full regression rejects unchanged named failures even after targeted acceptance passed", async () => {
    const baseline = acceptanceReport(
      testCheck("backend-test", nodeFailureOutput(7, "expected error one")),
    );
    const unchanged = acceptanceReport(
      testCheck("backend-test", nodeFailureOutput(1234, "expected error two")),
    );
    m.acceptance
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(
        acceptanceReport(testCheck("backend-test", "all tests passed", "passed")),
      )
      .mockResolvedValueOnce(unchanged);
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    expect(m.acceptance).toHaveBeenCalledTimes(3);
    expect(m.plan).toHaveBeenCalledTimes(8);
    const final = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    expect(final.phase).toBe("blocked");
    expect(final.repairAttempts).toBe(1);
    expect(final.error).toMatch(/未收敛|未取得进展/);
    expect(JSON.parse(final.acceptanceReport!)).toEqual(unchanged);
  });

  it.each([
    {
      scenario: "exact dependency/script guard",
      dependency: true,
      scriptError: true,
      cursor: 1,
      pending: false,
      discard: true,
    },
    {
      scenario: "generic failure report",
      dependency: false,
      scriptError: true,
      cursor: 1,
      pending: false,
      discard: false,
    },
    {
      scenario: "ordinary generation error",
      dependency: true,
      scriptError: false,
      cursor: 1,
      pending: false,
      discard: false,
    },
    {
      scenario: "no applied prefix",
      dependency: true,
      scriptError: true,
      cursor: 0,
      pending: false,
      discard: false,
    },
    {
      scenario: "pending suffix must reconcile",
      dependency: true,
      scriptError: true,
      cursor: 1,
      pending: true,
      discard: false,
    },
  ])(
    "dependency-ready repair recovery preserves applied records: $scenario",
    async ({ dependency, scriptError, cursor, pending, discard }) => {
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
      const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
      const baseline = acceptanceReport(
        testCheck(
          "frontend-build",
          dependency
            ? "VUE_PLUGIN_UNAVAILABLE: 无法加载 Vue 插件"
            : "Error: incompatible component export",
        ),
      );
      cp.phase = "blocked";
      cp.error = scriptError ? "验收脚本禁止增加构建前置自动安装" : "ordinary generation failure";
      cp.repairAttempts = 1;
      cp.repairFocusCheckId = "frontend-build";
      cp.repairBaselineReport = JSON.stringify(baseline);
      cp.acceptanceReport = JSON.stringify(baseline);
      cp.currentModule = {
        id: "repair-1",
        kind: "tests",
        title: "修复 Vue 依赖",
        featureIds: [],
        dependsOn: [],
        objective: "恢复本地插件并保留业务",
        acceptanceCriteria: ["真实构建及全工程回归"],
      };
      cp.currentPlan = {
        title: "持久化依赖修复",
        summary: "保留已应用前缀",
        risks: "",
        steps: [
          { action: "create", path: "client/src/applied.ts", reason: "已应用契约" },
          { action: "create", path: "client/src/unapplied.ts", reason: "未应用后缀" },
        ],
      };
      cp.generationBatches = [[0], [1]];
      cp.generationBatchKeys = ["files-0", "files-1"];
      cp.batchCursor = cursor;
      cp.appliedChangeSetIds = ["applied-prefix"];
      cp.changedFiles = [{ path: "client/src/applied.ts", action: "create" }];
      cp.pendingChangeSetId = pending ? "pending-suffix" : null;
      m.exists.mockReturnValue(true);
      m.read.mockReturnValue({ content: "export const applied = 42;" });
      m.changeFind.mockImplementation(async ({ where }) => {
        if (where.id === "applied-prefix")
          return {
            id: "applied-prefix",
            status: "accepted",
            changes: [
              {
                path: "client/src/applied.ts",
                action: "create",
                beforeContent: null,
                afterContent: "export const applied = 42;",
              },
            ],
          };
        if (where.id === "pending-suffix")
          return { id: "pending-suffix", status: "pending", changes: [] };
        return null;
      });
      m.plan.mockClear();
      m.implement.mockClear();
      m.pending.mockClear();
      m.accept.mockClear();
      m.acceptance.mockClear();
      m.acceptance.mockResolvedValue(
        acceptanceReport(testCheck("frontend-build", "build passed", "passed")),
      );
      await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl(), {
        id: "checkpoint",
        checkpoint: cp,
      });
      expect(m.plan).not.toHaveBeenCalled();
      expect(cp.phase).toBe("completed");
      expect(cp.appliedChangeSetIds).toContain("applied-prefix");
      expect(cp.changedFiles).toContainEqual({ path: "client/src/applied.ts", action: "create" });
      expect(m.accept).not.toHaveBeenCalledWith("applied-prefix", "user");
      expect(m.acceptance.mock.calls.map(([, options]) => options.onlyCheckIds)).toEqual([
        ["frontend-build"],
        undefined,
      ]);
      expect(cp.currentModule).toBeNull();
      expect(cp.currentPlan).toBeNull();
      expect(cp.generationBatches).toBeUndefined();
      expect(cp.generationBatchKeys).toBeUndefined();
      expect(cp.batchCursor).toBe(0);
      if (discard) {
        expect(m.implement).not.toHaveBeenCalled();
        expect(m.pending).not.toHaveBeenCalled();
        expect(m.accept).not.toHaveBeenCalled();
        expect(cp.appliedChangeSetIds).toEqual(["applied-prefix"]);
        expect(cp.changedFiles).toEqual([{ path: "client/src/applied.ts", action: "create" }]);
      } else if (pending) {
        expect(m.implement).not.toHaveBeenCalled();
        expect(m.accept).toHaveBeenCalledWith("pending-suffix", "user");
        expect(cp.appliedChangeSetIds).toContain("pending-suffix");
      } else {
        expect(m.implement.mock.calls.map(([input]) => input.plan.steps[0].path)).toEqual(
          cursor
            ? ["client/src/unapplied.ts"]
            : ["client/src/applied.ts", "client/src/unapplied.ts"],
        );
        expect(cp.completedModuleIds).toContain("repair-1");
      }
    },
  );

  it("resumes an interrupted focused repair from its snapshot before targeted and full acceptance", async () => {
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl());
    const cp = parseFullProjectCheckpoint(m.stepUpdate.mock.calls.at(-1)![0].data.detail)!;
    const baseline = acceptanceReport(testCheck("backend-test", nodeFailureOutput()));
    cp.phase = "repair";
    cp.repairAttempts = 1;
    cp.repairFocusCheckId = "backend-test";
    cp.repairBaselineReport = JSON.stringify(baseline);
    cp.acceptanceReport = JSON.stringify(baseline);
    cp.currentModule = {
      id: "repair-1",
      kind: "tests",
      title: "修复后端推荐测试",
      featureIds: [],
      dependsOn: [],
      objective: "保留业务契约修复根因",
      acceptanceCriteria: ["定向通过并全工程回归"],
    };
    cp.currentPlan = {
      title: "持久化修复计划",
      summary: "仅修复推荐根因",
      risks: "",
      steps: [
        { action: "create", path: "backend/src/recommendations.js", reason: "修复推荐回退契约" },
      ],
    };
    cp.batchCursor = 0;
    cp.appliedChangeSetIds = [];
    m.plan.mockClear();
    m.implement.mockClear();
    m.acceptance.mockClear();
    m.acceptance.mockResolvedValue(
      acceptanceReport(testCheck("backend-test", "all tests passed", "passed")),
    );
    await executeFullProjectTask(task, "project", "user", task.message, 240, ctrl(), {
      id: "checkpoint",
      checkpoint: cp,
    });
    expect(m.plan).not.toHaveBeenCalled();
    expect(m.implement).toHaveBeenCalledTimes(1);
    expect(m.implement.mock.calls[0][0].plan.steps[0].path).toBe("backend/src/recommendations.js");
    expect(m.acceptance.mock.calls.map(([, options]) => options.onlyCheckIds)).toEqual([
      ["backend-test"],
      undefined,
    ]);
    expect(m.implement.mock.invocationCallOrder[0]).toBeLessThan(
      m.acceptance.mock.invocationCallOrder[0],
    );
    expect(cp.completedModuleIds).toContain("repair-1");
    expect(cp.phase).toBe("completed");
  });
});
