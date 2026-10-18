import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "@prisma/client";
import type { CodexCheckpoint } from "@/server/agents/codex-checkpoint";
const m = vi.hoisted(() => ({ codex: vi.fn(), full: vi.fn(), legacyResume: vi.fn(), load: vi.fn(), save: vi.fn(), update: vi.fn() }));
vi.mock("@/server/db", () => ({ db: { agentTask: { update: m.update } } }));
vi.mock("@/server/agents/codex-task", () => ({ executeCodexTask: m.codex }));
vi.mock("@/server/agents/full-project", () => ({ executeFullProjectTask: m.full, resumeFullProjectTask: m.legacyResume }));
vi.mock("@/server/agents/codex-checkpoint", () => ({ loadCodexCheckpoint: m.load, saveCodexCheckpoint: m.save }));
import { startAgentTask, resumeAgentTask, pauseTask, resumeTask, releaseTaskController, isRunningInProcess, type TaskControl } from "@/server/agents/runner";
const task = { id: "dispatch-task", projectId: "dispatch-project", status: "failed", message: "test" } as AgentTask;
const cp = { engine: "codex", mode: "local", phase: "paused", projectId: task.projectId, taskId: task.id, message: "saved", pendingChangeSetId: null } as CodexCheckpoint;
let settle: () => void;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("GRADUATESTUDIO_AGENT_ENGINE", "codex");
  m.codex.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve; }));
  m.load.mockResolvedValue(cp);
});
afterEach(() => { releaseTaskController(task.id); vi.unstubAllEnvs(); });
describe("Codex unified dispatch and lifecycle", () => {
  it.each(["full", "local"] as const)("dispatches %s to Codex before legacy full", async (mode) => {
    expect(startAgentTask(task, task.projectId, "user", "goal", 18, mode)).toBe(true);
    await vi.waitFor(() => expect(m.codex).toHaveBeenCalled());
    expect(m.codex.mock.calls[0][5]).toEqual({ mode });
    expect(m.full).not.toHaveBeenCalled();
    settle(); await vi.waitFor(() => expect(isRunningInProcess(task.id)).toBe(false));
  });
  it("native pause aborts; resume waits for settled execution and creates fresh controller", async () => {
    startAgentTask(task, task.projectId, "user", "goal", 18);
    await vi.waitFor(() => expect(m.codex).toHaveBeenCalledTimes(1));
    const first = m.codex.mock.calls[0][4] as TaskControl;
    expect(first.engine).toBe("codex"); expect(pauseTask(task.id)).toBe(true);
    expect(first.abort.signal.aborted).toBe(true); expect(resumeTask(task.id)).toBe(false);
    expect(await resumeAgentTask(task, task.projectId, "user")).toBe(false);
    settle(); await vi.waitFor(() => expect(isRunningInProcess(task.id)).toBe(false));
    vi.stubEnv("GRADUATESTUDIO_AGENT_ENGINE", "legacy");
    expect(await resumeAgentTask(task, task.projectId, "user")).toBe(true);
    await vi.waitFor(() => expect(m.codex).toHaveBeenCalledTimes(2));
    const fresh = m.codex.mock.calls[1][4] as TaskControl;
    expect(fresh.abort).not.toBe(first.abort); expect(fresh.abort.signal.aborted).toBe(false);
    expect(m.legacyResume).not.toHaveBeenCalled(); settle();
    await vi.waitFor(() => expect(isRunningInProcess(task.id)).toBe(false));
  });
  it.each(["awaiting_acceptance", "applied_unverified"])("refuses %s without legacy fallback", async (phase) => {
    m.load.mockResolvedValue({ ...cp, phase });
    await expect(resumeAgentTask(task, task.projectId, "user")).rejects.toThrow();
    expect(m.codex).not.toHaveBeenCalled(); expect(m.legacyResume).not.toHaveBeenCalled();
  });
  it("rejects cross-project task linkage before loading state", async () => {
    await expect(resumeAgentTask(task, "other", "user")).rejects.toThrow();
    expect(m.load).not.toHaveBeenCalled();
  });
});
