import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  find: vi.fn(),
  resume: vi.fn(),
  running: vi.fn(),
  owner: vi.fn(),
  auth: vi.fn(),
  checkpoint: vi.fn(),
  reconcile: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/server/auth", () => ({ auth: m.auth }));
vi.mock("@/server/agents/codex-checkpoint", () => ({
  loadCodexCheckpoint: m.checkpoint,
  saveCodexCheckpoint: vi.fn(),
}));
vi.mock("@/server/agents/codex-review", () => ({ reconcileCodexReview: m.reconcile }));
vi.mock("@/server/agents/context", () => ({ assertProjectOwner: m.owner }));
vi.mock("@/server/db", () => ({ db: { agentTask: { findFirst: m.find, update: m.update } } }));
vi.mock("@/server/agents/runner", () => ({
  isRunningInProcess: m.running,
  cancelTask: vi.fn(),
  pauseTask: vi.fn(),
  resumeTask: vi.fn(),
  resumeAgentTask: m.resume,
}));
vi.mock("@/server/agents/full-project", () => ({ resumeFullProjectTask: m.resume }));
import { POST } from "@/app/api/projects/[id]/agent-tasks/[taskId]/control/route";
const call = (action: string) =>
  POST(new Request("http://localhost/api", { method: "POST", body: JSON.stringify({ action }) }), {
    params: Promise.resolve({ id: "project", taskId: "task" }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user" } });
  m.running.mockReturnValue(false);
  m.checkpoint.mockResolvedValue(null);
  m.resume.mockResolvedValue(true);
  m.find
    .mockResolvedValueOnce({
      id: "task",
      status: "failed",
      steps: [{ detail: "FULL_PROJECT_CHECKPOINT\n{}" }],
    })
    .mockResolvedValue(null);
});
describe("explicit checkpoint continuation", () => {
  it("allows ending applied-unverified review without rerunning or claiming acceptance", async () => {
    m.checkpoint.mockResolvedValue({ phase: "applied_unverified", pendingChangeSetId: "review" });
    expect((await call("cancel")).status).toBe(200);
    expect(m.resume).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "cancelled",
          error: expect.stringContaining("不表示验收"),
        }),
      }),
    );
  });
  it("resumes local Codex checkpoints without requiring legacy step notes", async () => {
    m.find
      .mockReset()
      .mockResolvedValueOnce({ id: "task", status: "paused", steps: [] })
      .mockResolvedValue(null);
    m.checkpoint.mockResolvedValue({ phase: "paused", pendingChangeSetId: null });
    expect((await call("retry")).status).toBe(200);
    expect(m.resume).toHaveBeenCalled();
  });
  it.each(["awaiting_acceptance", "applied_unverified"])(
    "blocks review state %s before any rerun",
    async (phase) => {
      m.checkpoint.mockResolvedValue({ phase, pendingChangeSetId: "review" });
      expect((await call("retry")).status).toBe(409);
      expect(m.resume).not.toHaveBeenCalled();
    },
  );
  it.each(["retry", "extend-budget", "resume"])(
    "%s resumes with no budget addition",
    async (action) => {
      expect((await call(action)).status).toBe(200);
      expect(m.resume).toHaveBeenCalledWith(expect.anything(), "project", "user");
      expect(m.owner).toHaveBeenCalledWith("project", "user");
      expect(m.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "task", projectId: "project", project: { userId: "user" } },
        }),
      );
    },
  );
  it("rejects live legacy continuation before resume", async () => {
    m.running.mockReturnValue(true);
    expect((await call("extend-budget")).status).toBe(409);
    expect(m.resume).not.toHaveBeenCalled();
  });
  it("preserves authentication", async () => {
    m.auth.mockResolvedValue(null);
    expect((await call("retry")).status).toBe(401);
    expect(m.owner).not.toHaveBeenCalled();
    expect(m.resume).not.toHaveBeenCalled();
  });
  it("does not continue a task without an owned checkpoint", async () => {
    m.find.mockReset().mockResolvedValueOnce({ id: "task", status: "failed", steps: [] });
    expect((await call("retry")).status).toBe(409);
    expect(m.resume).not.toHaveBeenCalled();
  });
  it("refuses tasks outside the owned project", async () => {
    m.find.mockReset().mockResolvedValue(null);
    expect((await call("retry")).status).toBe(404);
    expect(m.resume).not.toHaveBeenCalled();
  });
});
