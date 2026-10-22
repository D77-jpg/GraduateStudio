import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const m = vi.hoisted(() => ({
  owner: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  lease: vi.fn(),
  release: vi.fn(),
  deps: vi.fn(),
  accept: vi.fn(),
  diagnostic: vi.fn(),
  ensure: vi.fn(),
  task: vi.fn(),
  create: vi.fn(),
  step: vi.fn(),
}));
vi.mock("@/server/db", () => ({
  db: { agentTask: { update: m.task }, agentStep: { create: m.create, update: m.step } },
}));
vi.mock("@/server/agents/context", () => ({ assertProjectOwner: m.owner }));
vi.mock("@/server/workspace/paths", () => ({ ensureProjectDir: m.ensure }));
vi.mock("@/server/agents/codex-checkpoint", () => ({
  loadCodexCheckpoint: m.load,
  saveCodexCheckpoint: m.save,
}));
vi.mock("@/server/agents/codex-lease", () => ({ acquireCodexProjectLease: m.lease }));
vi.mock("@/server/agents/codex-dependencies", () => ({ prepareCodexDependencies: m.deps }));
// 应用后验证统一走交付闸门；m.accept 代替 runDeliveryGate(copy, options)。
vi.mock("@/server/agents/delivery-gate", () => ({ runDeliveryGate: m.accept }));
vi.mock("@/server/runtime/codex-runtime-diagnostics", () => ({
  collectRuntimeRepairEvidence: m.diagnostic,
}));
import {
  startCodexPostApplyVerification as start,
  cancelCodexPostApplyVerification as cancel,
  isCodexPostApplyVerificationRunning as isRunning,
  awaitCodexPostApplyVerification as awaitVerification,
} from "@/server/agents/codex-post-apply";
let root: string, original: string, stage: string;
let cp: Record<string, unknown>;
async function settle() {
  await awaitVerification("task");
  expect(isRunning("task")).toBe(false);
}
async function report() {
  return JSON.parse(
    await fs.readFile(path.join(path.dirname(stage), "post-apply-verification.json"), "utf8"),
  );
}
beforeEach(async () => {
  vi.resetAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-post-"));
  original = path.join(root, "project");
  stage = path.join(root, "state", "stage");
  await fs.mkdir(original, { recursive: true });
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(original, "index.js"), "original");
  cp = {
    version: 1,
    projectId: "project",
    taskId: "task",
    stage,
    phase: "applied_unverified",
    nextStepIndex: 7,
  };
  m.task.mockResolvedValue(undefined);
  m.load.mockImplementation(async () => ({ ...cp }));
  m.save.mockResolvedValue(undefined);
  m.ensure.mockReturnValue(original);
  m.lease.mockResolvedValue(m.release);
  m.create.mockResolvedValue({ id: "step" });
  m.deps.mockResolvedValue({ status: "passed", reason: "offline", roots: [] });
  m.accept.mockResolvedValue({
    status: "passed",
    checks: [{ name: "node:test", status: "passed", output: "ok" }],
  });
});
afterEach(async () => {
  if (isRunning("task")) await cancel("task");
  await fs.rm(root, { recursive: true, force: true });
});
describe("post-apply independent engineering verification", () => {
  it("reobserves runtime repair after application without changing business acceptance", async () => {
    cp.mode = "local";
    cp.message = "修复任务 #9 失败";
    m.diagnostic.mockResolvedValue({
      version: 1,
      status: "collected",
      taskId: 9,
      connectivity: "refused",
      modelCalls: 0,
    });
    await start("project", "task", "user");
    await settle();
    expect(m.diagnostic).toHaveBeenCalledWith("project", cp.message, expect.any(AbortSignal));
    expect(
      m.create.mock.calls.some(([call]) => call.data.detail?.startsWith("RUNTIME_REPAIR_REPORT\n")),
    ).toBe(true);
    expect((await report()).businessAcceptance).toBe("pending");
  });
  it("blocks empty coverage and gives failures precedence over blocked preparation", async () => {
    m.accept.mockResolvedValueOnce({ status: "passed", checks: [] });
    await start("project", "task", "user");
    await settle();
    expect((await report()).status).toBe("blocked");
    m.deps.mockResolvedValue({ status: "blocked", reason: "cache absent", roots: [] });
    m.accept.mockResolvedValueOnce({
      status: "failed",
      checks: [{ name: "test", status: "failed", output: "failure" }],
    });
    await start("project", "task", "user");
    await settle();
    expect((await report()).status).toBe("failed");
  });
  it("copies CURRENT applied project, keeps phase unchanged and returns paused even on pass", async () => {
    await fs.writeFile(path.join(stage, "old-model.txt"), "stale");
    expect(await start("project", "task", "user")).toBe(true);
    await settle();
    const copy = m.accept.mock.calls[0][0];
    expect(copy).not.toBe(original);
    expect(copy).not.toBe(stage);
    expect(copy).toContain("post-apply-copy-");
    expect(await fs.readFile(path.join(original, "index.js"), "utf8")).toBe("original");
    expect(await fs.readFile(path.join(stage, "old-model.txt"), "utf8")).toBe("stale");
    await expect(fs.stat(copy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(m.save.mock.calls[0][0]).toMatchObject({
      phase: "applied_unverified",
      nextStepIndex: 8,
    });
    expect(m.create.mock.calls[0][0].data.index).toBe(7);
    expect(m.task.mock.calls.map((c) => c[0].data.status)).toEqual(["checking", "paused"]);
    expect((await report()).status).toBe("passed");
    expect((await report()).businessAcceptance).toBe("pending");
    const detail = m.step.mock.calls.at(-1)?.[0].data.detail;
    expect(detail.startsWith("ACCEPTANCE_REPORT\n")).toBe(true);
    expect(JSON.parse(detail.slice("ACCEPTANCE_REPORT\n".length))).toMatchObject({
      version: 1,
      status: "passed",
      checks: [{ label: "node:test", status: "passed" }],
    });
    expect(m.release).toHaveBeenCalledOnce();
  });
  it("preserves recorded command and timing without fabricating unknown metadata", async () => {
    m.accept.mockResolvedValue({
      status: "passed",
      checks: [
        { name: "client:build", status: "passed", output: "ok" },
        {
          name: "server:maven:test",
          status: "passed",
          output: "Tests run: 6",
          command: "mvn -B test",
          durationMs: 1234.5,
        },
      ],
    });
    await start("project", "task", "user");
    await settle();
    const detail = m.step.mock.calls.at(-1)?.[0].data.detail;
    const projected = JSON.parse(detail.slice("ACCEPTANCE_REPORT\n".length));
    expect(projected.checks[0]).not.toHaveProperty("command");
    expect(projected.checks[0]).not.toHaveProperty("durationMs");
    expect(projected.checks[1]).toMatchObject({ command: "mvn -B test", durationMs: 1234.5 });
    expect(projected.limitations.join("\n")).toContain("官方工具链镜像");
    expect(projected.limitations.join("\n")).toContain("compose.yaml");
    expect((await report()).acceptance.checks[1]).toMatchObject({
      command: "mvn -B test",
      durationMs: 1234.5,
    });
  });
  it("does not manufacture durations for lifecycle errors", async () => {
    m.accept.mockRejectedValue(new Error("fixture failed"));
    await start("project", "task", "user");
    await settle();
    const detail = m.step.mock.calls.at(-1)?.[0].data.detail;
    const projected = JSON.parse(detail.slice("ACCEPTANCE_REPORT\n".length));
    expect(projected.checks.map((check: { label: string }) => check.label)).toEqual(["验证流程"]);
    for (const check of projected.checks) {
      expect(check).not.toHaveProperty("durationMs");
      expect(check).not.toHaveProperty("command");
    }
  });
  it("authorizes before state, refuses wrong checkpoint phase without checks", async () => {
    m.owner.mockRejectedValueOnce(new Error("unauthorized"));
    await expect(start("project", "task", "user")).rejects.toThrow("unauthorized");
    expect(m.load).not.toHaveBeenCalled();
    cp.phase = "awaiting_acceptance";
    await expect(start("project", "task", "user")).rejects.toThrow("只有");
    expect(m.accept).not.toHaveBeenCalled();
  });
  it("deduplicates and cancellation waits for checks and lease release", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r));
    m.accept.mockImplementation(
      (_p, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          entered();
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    expect(await start("project", "task", "user")).toBe(true);
    await ready;
    expect(await start("project", "task", "user")).toBe(false);
    expect(await cancel("task")).toBe(true);
    expect(isRunning("task")).toBe(false);
    expect((await report()).cancelled).toBe(true);
    expect((await report()).status).toBe("blocked");
    expect(m.release).toHaveBeenCalledOnce();
  });
  it("verifies the Java backend that the old npm/Python-only path ignored", async () => {
    await fs.mkdir(path.join(original, "server"));
    await fs.writeFile(path.join(original, "server", "pom.xml"), "<project/>");
    m.accept.mockResolvedValue({
      status: "failed",
      checks: [
        { name: "client:build", status: "passed", output: "ok" },
        { name: "server:maven:test", status: "failed", output: "cannot find symbol" },
      ],
    });
    await start("project", "task", "user");
    await settle();
    const copy = m.accept.mock.calls[0][0];
    expect(m.accept.mock.calls[0][1]).toMatchObject({ tier: "auto" });
    expect(copy).toContain("post-apply-copy-");
    const r = await report();
    expect(r.status).toBe("failed");
    expect(r.acceptance.checks).toContainEqual(
      expect.objectContaining({ name: "server:maven:test", status: "failed" }),
    );
  });
  it("passes frozen plan smoke to the gate when the task has a full-development journal", async () => {
    const smoke = [
      { kind: "http", as: "admin", method: "POST", path: "/api/x", expectStatus: 200, saveAs: { id: "data.id" } },
      { kind: "http", as: "admin", method: "GET", path: "/api/x/{{id}}", expectStatus: 200 },
      { kind: "page", as: "admin", route: "/x", expectText: ["X"] },
    ];
    await fs.writeFile(
      path.join(path.dirname(stage), "journal.json"),
      JSON.stringify({
        plan: {
          version: 2,
          modules: [{ id: "x", title: "X", dependsOn: [], featureIds: ["f"], acceptanceCriteria: ["c"], smoke }],
        },
      }),
    );
    await start("project", "task", "user");
    await settle();
    expect(m.accept.mock.calls[0][1].smoke).toEqual([{ moduleId: "x", smoke }]);
  });
  it("rejects successful report if actual project changes during verification", async () => {
    m.accept.mockImplementation(async () => {
      await fs.writeFile(path.join(original, "index.js"), "concurrent change");
      return { status: "passed", checks: [] };
    });
    await start("project", "task", "user");
    await settle();
    expect((await report()).status).toBe("failed");
    expect((await report()).error).toContain("项目发生变化");
  });
  it("reports a blocked gate (e.g. unsupported stack) as blocked without paid repair", async () => {
    m.accept.mockResolvedValue({
      status: "blocked",
      checks: [{ name: "stack:server:gradle", status: "blocked", output: "unsupported" }],
    });
    await start("project", "task", "user");
    await settle();
    expect((await report()).status).toBe("blocked");
  });
  it("can retry after a failed check using a new copy and incremented durable step", async () => {
    m.accept.mockRejectedValueOnce(new Error("fixture failed"));
    await start("project", "task", "user");
    await settle();
    expect((await report()).status).toBe("failed");
    cp.nextStepIndex = 8;
    await start("project", "task", "user");
    await settle();
    expect((await report()).status).toBe("passed");
    expect(m.accept.mock.calls[0][0]).not.toBe(m.accept.mock.calls[1][0]);
    expect(m.save.mock.calls.some((c) => c[0].nextStepIndex === 9)).toBe(true);
  });
});
