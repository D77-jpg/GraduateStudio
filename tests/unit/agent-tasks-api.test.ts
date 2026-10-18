import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  auth: vi.fn(),
  running: vi.fn(),
  requirement: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  start: vi.fn(),
  activity: vi.fn(),
  ai: vi.fn(),
}));
vi.mock("@/server/auth", () => ({ auth: mocks.auth }));
vi.mock("@/server/agents/context", () => ({
  assertProjectOwner: mocks.owner,
  buildCodingContext: async () => ({
    projectText: "Node.js Express Vue",
    architectureText: "MySQL",
  }),
}));
vi.mock("@/server/agents/runner", () => ({
  startAgentTask: mocks.start,
  reapOrphanTasks: vi.fn(),
  isRunningInProcess: vi.fn(),
}));
vi.mock("@/server/ai", () => ({ getAiStatus: mocks.ai }));
vi.mock("@/server/activity", () => ({ logActivity: mocks.activity }));
vi.mock("@/server/db", () => ({
  db: {
    agentTask: { findFirst: mocks.running, create: mocks.create, update: mocks.update },
    requirement: { findUnique: mocks.requirement },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ agentTask: { findFirst: mocks.running, create: mocks.create } }),
  },
}));
import { POST } from "@/app/api/projects/[id]/agent-tasks/route";
const call = (body: unknown) =>
  POST(new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "project" }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "user" } });
  mocks.running.mockResolvedValue(null);
  mocks.requirement.mockResolvedValue({ id: "req", _count: { features: 3 } });
  mocks.create.mockResolvedValue({ id: "task", status: "queued" });
  mocks.start.mockReturnValue(true);
  mocks.ai.mockReturnValue({ configured: true });
});
describe("one-click creation without model calls", () => {
  it("Codex creation never requires the legacy AI provider", async () => {
    vi.stubEnv("GRADUATESTUDIO_AGENT_ENGINE", "codex");
    mocks.ai.mockReturnValue({ configured: false });
    try {
      expect((await call({ mode: "full" })).status).toBe(201);
      expect(mocks.ai).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
  it("accepts full mode without manual message or step configuration", async () => {
    const response = await call({ mode: "full" });
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ maxSteps: 240, title: "[完整生成] 自动完成项目" }),
      }),
    );
    expect(mocks.start).toHaveBeenCalledWith(
      expect.anything(),
      "project",
      "user",
      expect.any(String),
      240,
      "full",
    );
  });
  it("refuses missing requirements before creating or starting", async () => {
    mocks.requirement.mockResolvedValue(null);
    expect((await call({ mode: "full" })).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("keeps legacy local message requests compatible", async () => {
    expect((await call({ message: "实现真实登录认证", maxSteps: 18 })).status).toBe(201);
    expect(mocks.start).toHaveBeenCalledWith(
      expect.anything(),
      "project",
      "user",
      "实现真实登录认证",
      18,
      "local",
    );
  });
  it.each([undefined, 0, 1, 999999, -1, "legacy", { corrupt: true }])(
    "ignores legacy local step limits: %j",
    async (maxSteps) => {
      expect((await call({ message: "实现真实登录认证", maxSteps })).status).toBe(201);
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ maxSteps: 18 }),
        }),
      );
      expect(mocks.start).toHaveBeenCalledWith(
        expect.anything(),
        "project",
        "user",
        "实现真实登录认证",
        18,
        "local",
      );
      expect(mocks.activity.mock.calls[0]?.[3]).toBe("mode=local");
    },
  );
  it("preserves authentication before creating a task", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await call({ mode: "full" })).status).toBe(401);
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("refuses occupied projects including paused tasks", async () => {
    mocks.running.mockResolvedValue({ id: "paused-task" });
    expect((await call({ mode: "full" })).status).toBe(409);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("does not leave a refused controller claim queued", async () => {
    mocks.start.mockReturnValue(false);
    expect((await call({ mode: "full" })).status).toBe(409);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
    );
  });
});
