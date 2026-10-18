import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "@prisma/client";
import type { AcceptanceReport } from "@/lib/acceptance";
import type { InvestigationOptions } from "@/server/agents/investigation";

const m = vi.hoisted(() => ({
  taskUpdate: vi.fn(),
  taskFind: vi.fn(),
  stepCreate: vi.fn(),
  stepUpdate: vi.fn(),
  stepUpdateMany: vi.fn(),
  changeCreate: vi.fn(),
  context: vi.fn(),
  plan: vi.fn(),
  implement: vi.fn(),
  generate: vi.fn(),
  pending: vi.fn(),
  accept: vi.fn(),
  acceptance: vi.fn(),
  investigate: vi.fn(),
  read: vi.fn(),
  exists: vi.fn(),
  fsRead: vi.fn(),
  fsWrite: vi.fn(),
  fsCopy: vi.fn(),
  fsRemove: vi.fn(),
  exec: vi.fn(),
  activity: vi.fn(),
  gitStatus: vi.fn(),
  commit: vi.fn(),
  commitMessage: vi.fn(),
  events: [] as string[],
}));

vi.mock("@/server/db", () => ({
  db: {
    agentTask: { update: m.taskUpdate, findUnique: m.taskFind },
    agentStep: {
      create: m.stepCreate,
      update: m.stepUpdate,
      updateMany: m.stepUpdateMany,
    },
    changeSet: { create: m.changeCreate },
  },
}));
vi.mock("@/server/agents/context", () => ({ buildCodingContext: m.context }));
vi.mock("@/server/agents/coding-agent", () => ({
  generatePlan: m.plan,
  generateImplementation: m.implement,
}));
vi.mock("@/server/ai/compat", () => ({ generateObjectCompat: m.generate }));
vi.mock("@/server/changesets", () => ({
  createPendingChangeSet: m.pending,
  acceptChangeSet: m.accept,
}));
vi.mock("@/server/workspace/paths", () => ({
  PROJECT_ID_PATTERN: /^[a-zA-Z0-9_-]{1,64}$/,
  getWorkspaceRoot: () => "Z:/mock-workspace",
  resolveProjectDir: () => "Z:/mock-project-do-not-access",
  safeJoin: (root: string, file: string) => `${root}/${file}`,
}));
vi.mock("@/server/workspace/files", () => ({ readFileContent: m.read }));
vi.mock("node:fs", () => ({
  default: {
    existsSync: m.exists,
    readFileSync: m.fsRead,
    writeFileSync: m.fsWrite,
    copyFileSync: m.fsCopy,
    rmSync: m.fsRemove,
  },
}));
vi.mock("node:child_process", () => ({ execFile: m.exec }));
vi.mock("@/server/agents/acceptance", () => ({ runProjectAcceptance: m.acceptance }));
vi.mock("@/server/agents/investigation", () => ({
  investigateAcceptanceFailure: m.investigate,
}));
vi.mock("@/server/activity", () => ({ logActivity: m.activity }));
vi.mock("@/server/git", () => ({ getStatus: m.gitStatus, commitAll: m.commit }));
vi.mock("@/server/git-ai", () => ({
  generateCommitMessage: m.commitMessage,
  fallbackCommitMessage: () => "fix: tested change",
}));

import { executeTask, type TaskControl } from "@/server/agents/runner";

const projectDir = "Z:/mock-project-do-not-access";
const sourcePath = "backend/src/orders.ts";
const initialChange = {
  path: sourcePath,
  action: "create" as const,
  content: "export const orderTotal = 0;",
};
const repairChange = {
  path: sourcePath,
  action: "modify" as const,
  content: "export const orderTotal = 42;",
};
const evidencePaths = ["backend/tests/orders.test.ts", sourcePath];
const task = { id: "ordinary-task", title: "Implement orders", projectId: "project" } as AgentTask;
const failureOutput = (duration = 8) => `
 FAIL  tests/orders.test.ts > orders > computes total
 AssertionError: expected 0 to be 42
 Expected: 42
 Received: 0
 at backend/tests/orders.test.ts:12:5
 Tests 1 failed (1)
 Duration ${duration}ms
`;
function report(
  status: AcceptanceReport["status"],
  output = status === "passed" ? "Tests 1 passed (1)" : failureOutput(),
): AcceptanceReport {
  return {
    version: 1,
    status,
    checks: [{ id: "backend-test", label: "Backend tests", status, command: "node --test", output, durationMs: 8 }],
    limitations: [],
  };
}
function control(): TaskControl {
  return { cancelled: false, paused: false, abort: new AbortController() };
}
async function run() {
  const ctrl = control();
  await executeTask(task, "project", "user", "Implement order totals", 40, ctrl);
  return ctrl;
}
function expectFailed(message: string) {
  expect(m.taskUpdate).toHaveBeenLastCalledWith({
    where: { id: task.id },
    data: { status: "failed", finishedAt: expect.any(Date), error: expect.stringContaining(message) },
  });
  expect(m.taskUpdate.mock.calls.some(([input]) => input.data.status === "completed")).toBe(false);
}
function expectNoRepairWrites() {
  // The ordinary implementation is already accepted; investigation must add no writes.
  expect(m.plan).toHaveBeenCalledTimes(1);
  expect(m.implement).toHaveBeenCalledTimes(1);
  expect(m.pending).toHaveBeenCalledTimes(1);
  expect(m.accept).toHaveBeenCalledTimes(1);
  expect(m.changeCreate).not.toHaveBeenCalled();
  expect(m.fsWrite).not.toHaveBeenCalled();
  expect(m.acceptance).toHaveBeenCalledTimes(1);
  expect(m.read).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  m.events.length = 0;
  m.taskUpdate.mockResolvedValue({});
  m.taskFind.mockResolvedValue({ gitCommitHash: null });
  m.stepCreate.mockImplementation(async ({ data }) => ({ id: `step-${data.index}` }));
  m.stepUpdate.mockResolvedValue({});
  m.stepUpdateMany.mockResolvedValue({ count: 0 });
  m.context.mockResolvedValue({ fileTreeText: "backend/src/orders.ts", requirementText: "orders", architectureText: "Node backend" });
  m.plan.mockImplementation(async (input) => {
    const repair = input.moduleScoped === true;
    m.events.push(repair ? "repair-plan" : "initial-plan");
    return {
      title: repair ? "Repair order total" : "Implement orders",
      summary: "Order totals",
      risks: "",
      steps: [{ path: sourcePath, action: repair ? "modify" : "create", reason: "Correct the total demonstrated by the failed assertion" }],
    };
  });
  m.implement.mockImplementation(async ({ plan }) => {
    const repair = plan.steps[0].action === "modify";
    m.events.push(repair ? "repair-implementation" : "initial-implementation");
    return { notes: repair ? "Corrected total without changing tests" : "Implemented totals", changes: [repair ? repairChange : initialChange] };
  });
  m.pending.mockImplementation(async ({ changes }) => {
    const repair = changes[0].action === "modify";
    m.events.push(repair ? "repair-pending" : "initial-pending");
    return { id: repair ? "repair-changeset" : "initial-changeset" };
  });
  m.accept.mockImplementation(async (id) => {
    m.events.push(id === "repair-changeset" ? "repair-accepted" : "initial-accepted");
    return { id, changes: [id === "repair-changeset" ? repairChange : initialChange] };
  });
  m.acceptance.mockImplementation(async (_dir, options) => {
    m.events.push(options.onlyCheckIds ? "targeted-acceptance" : "full-acceptance");
    return report("passed");
  });
  m.investigate.mockImplementation(async () => {
    m.events.push("investigation");
    return { disposition: "repair", summary: "Read test and implementation: total is incorrectly hard-coded to zero", paths: evidencePaths, observations: [] };
  });
  m.read.mockReturnValue({ content: initialChange.content });
  m.exists.mockReturnValue(false);
  m.gitStatus.mockResolvedValue({ initialized: false, changes: [] });
});

describe("ordinary executeTask engineering investigation integration", () => {
  it("investigates before a minimal tracked repair, then runs targeted and full acceptance", async () => {
    const failed = report("failed");
    m.acceptance.mockImplementation(async (_dir, options) => {
      m.events.push(options.onlyCheckIds ? "targeted-acceptance" : "full-acceptance");
      return m.acceptance.mock.calls.length === 1 ? failed : report("passed");
    });
    m.investigate.mockImplementation(async (options: InvestigationOptions) => {
      m.events.push("investigation");
      await options.onObservation?.({ id: 0, request: { tool: "read_file", path: sourcePath }, result: { ok: true, content: initialChange.content } }, "Read source to confirm the failed total contract");
      return { disposition: "repair", summary: "Confirmed hard-coded total from source and failing test", paths: evidencePaths, observations: [] };
    });
    const ctrl = await run();

    expect(m.events).toEqual([
      "initial-plan", "initial-implementation", "initial-pending", "initial-accepted",
      "full-acceptance", "investigation", "repair-plan", "repair-implementation",
      "repair-pending", "repair-accepted", "targeted-acceptance", "full-acceptance",
    ]);
    expect(m.investigate).toHaveBeenCalledWith(expect.objectContaining({ projectDir, report: failed, focusId: "backend-test", signal: ctrl.abort.signal, onObservation: expect.any(Function) }));
    expect(m.plan.mock.calls[1][0]).toMatchObject({ projectId: "project", userId: "user", selectedFilePaths: evidencePaths, moduleScoped: true, signal: ctrl.abort.signal });
    expect(m.plan.mock.calls[1][0].message).toContain("backend-test");
    expect(m.plan.mock.calls[1][0].message).toContain("Confirmed hard-coded total");
    expect(m.implement.mock.calls[1][0]).toMatchObject({ selectedFilePaths: evidencePaths, plan: { steps: [{ path: sourcePath, action: "modify" }] } });
    expect(m.read).toHaveBeenCalledWith("project", "user", sourcePath);
    expect(m.pending.mock.calls[1][0]).toMatchObject({ title: "Repair order total", changes: [repairChange] });
    expect(m.accept).toHaveBeenNthCalledWith(2, "repair-changeset", "user");
    expect(m.stepUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "done", changeSetId: "repair-changeset" }) }));
    expect(m.stepCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: "diagnostic", title: "调查工具：read_file" }) }));
    expect(m.stepUpdate.mock.calls.some(([input]) => input.data.detail?.includes("Read source to confirm"))).toBe(true);
    expect(m.acceptance).toHaveBeenNthCalledWith(1, projectDir, { signal: ctrl.abort.signal });
    expect(m.acceptance).toHaveBeenNthCalledWith(2, projectDir, { signal: ctrl.abort.signal, onlyCheckIds: ["backend-test"] });
    expect(m.acceptance).toHaveBeenNthCalledWith(3, projectDir, { signal: ctrl.abort.signal });
    expect(m.taskUpdate).toHaveBeenCalledWith({ where: { id: task.id }, data: { fixAttempts: 1, status: "checking" } });
    expect(m.taskUpdate).toHaveBeenLastCalledWith({ where: { id: task.id }, data: { status: "completed", finishedAt: expect.any(Date), error: null } });
    expect(m.fsWrite).not.toHaveBeenCalled();
    expect(m.changeCreate).not.toHaveBeenCalled();
    expect(m.exec).not.toHaveBeenCalled();
    expect(m.generate).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
  });

  it.each(["environment", "insufficient"])("does not generate or write a repair for an %s investigation", async (disposition) => {
    m.acceptance.mockResolvedValue(report("failed"));
    m.investigate.mockResolvedValue({ disposition, summary: "No safe code repair supported by tool evidence", paths: [], observations: [] });
    await run();
    expect(m.investigate).toHaveBeenCalledTimes(1);
    expectNoRepairWrites();
    expectFailed("工程验收未通过");
  });

  it("investigates an environment-blocked report but never writes even if investigation suggests repair", async () => {
    m.acceptance.mockResolvedValue(report("blocked", "Required tool node unavailable: ENOENT"));
    await run();
    expect(m.investigate).toHaveBeenCalledTimes(1);
    expectNoRepairWrites();
    expectFailed("工程验收受阻");
  });

  it("does not write speculative repairs when the failure has insufficient acceptance diagnostics", async () => {
    m.acceptance.mockResolvedValue(report("failed", "Tests 1 failed (1)\nDuration 8ms"));
    await run();
    expect(m.investigate).toHaveBeenCalledTimes(1);
    expectNoRepairWrites();
    expectFailed("工程验收未通过");
  });

  it("stops an unchanged failure after one repair instead of investigating or writing repeatedly", async () => {
    m.acceptance
      .mockResolvedValueOnce(report("failed", failureOutput(8)))
      .mockResolvedValueOnce(report("passed"))
      .mockResolvedValue(report("failed", failureOutput(91)));
    await run();
    expect(m.investigate).toHaveBeenCalledTimes(1);
    expect(m.plan).toHaveBeenCalledTimes(2);
    expect(m.implement).toHaveBeenCalledTimes(2);
    expect(m.pending).toHaveBeenCalledTimes(2);
    expect(m.accept).toHaveBeenCalledTimes(2);
    expect(m.acceptance).toHaveBeenCalledTimes(3);
    expectFailed("工程验收未通过");
  });

  it("requires full regression acceptance even when targeted acceptance passes", async () => {
    m.acceptance
      .mockResolvedValueOnce(report("failed"))
      .mockResolvedValueOnce(report("passed"))
      .mockResolvedValueOnce(report("blocked", "Required tool node unavailable: ENOENT"));
    m.investigate
      .mockResolvedValueOnce({ disposition: "repair", summary: "Confirmed total contract", paths: evidencePaths, observations: [] })
      .mockResolvedValue({ disposition: "environment", summary: "Node unavailable during regression", paths: [], observations: [] });
    await run();
    expect(m.acceptance).toHaveBeenCalledTimes(3);
    expect(m.investigate).toHaveBeenCalledTimes(2);
    expect(m.pending).toHaveBeenCalledTimes(2);
    expectFailed("工程验收受阻");
  });

  it("skips investigation and repair generation entirely when initial acceptance passes", async () => {
    await run();
    expect(m.investigate).not.toHaveBeenCalled();
    expectNoRepairWrites();
    expect(m.stepCreate.mock.calls.some(([input]) => input.data.kind === "diagnostic")).toBe(false);
    expect(m.taskUpdate).toHaveBeenLastCalledWith({ where: { id: task.id }, data: { status: "completed", finishedAt: expect.any(Date), error: null } });
    expect(m.exec).not.toHaveBeenCalled();
    expect(m.generate).not.toHaveBeenCalled();
    expect(m.fsRead).not.toHaveBeenCalled();
  });
});
