import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  owner: vi.fn(),
  task: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  lastStep: vi.fn(),
  createStep: vi.fn(),
  checkpoint: vi.fn(),
  saveCheckpoint: vi.fn(),
  collect: vi.fn(),
}));
vi.mock("@/server/auth", () => ({ auth: m.auth }));
vi.mock("@/server/agents/context", () => ({ assertProjectOwner: m.owner }));
vi.mock("@/server/agents/codex-checkpoint", () => ({
  loadCodexCheckpoint: m.checkpoint,
  saveCodexCheckpoint: m.saveCheckpoint,
}));
vi.mock("@/server/db", () => ({
  db: {
    agentTask: { findFirst: m.task, update: m.update, updateMany: m.updateMany },
    agentStep: { findFirst: m.lastStep, create: m.createStep },
  },
}));
// All runtime inspection is mocked: these tests cannot execute Docker or real probes.
vi.mock("@/server/runtime/codex-runtime-diagnostics", () => ({
  collectRuntimeRepairEvidence: m.collect,
}));
import { POST } from "@/app/api/projects/[id]/agent-tasks/[taskId]/diagnose/route";

const runtimeGlobal = globalThis as typeof globalThis & {
  graduateStudioAgentControllers?: Map<string, unknown>;
  graduateStudioRuntimeDiagnoses?: Map<string, true>;
};
const storedMessage = "请排查业务任务 #42 无法连接模型的错误";
const report = {
  version: 1,
  status: "collected",
  taskId: 42,
  taskState: "failed",
  failureCode: "MODEL_CONNECT_ERROR",
  failureSummary: "Connection failed",
  endpoint: { serviceId: 1, port: 8000, hostKind: "private" },
  connectivity: "refused",
  modelCalls: 0,
  needsUserAction: true,
  issues: [],
};
function call(body?: string, taskId = "agent-task", signal?: AbortSignal) {
  const request = new Request("http://localhost/api/projects/project/agent-tasks/task/diagnose", {
    method: "POST",
    ...(body === undefined ? {} : { body }),
    signal,
  });
  return {
    request,
    response: POST(request, { params: Promise.resolve({ id: "project", taskId }) }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  runtimeGlobal.graduateStudioAgentControllers = new Map();
  runtimeGlobal.graduateStudioRuntimeDiagnoses?.clear();
  m.auth.mockResolvedValue({ user: { id: "owner" } });
  m.owner.mockResolvedValue(undefined);
  m.task.mockResolvedValue({ message: storedMessage });
  m.checkpoint.mockResolvedValue({ mode: "local" });
  m.collect.mockResolvedValue(report);
  m.lastStep.mockResolvedValue({ index: 7 });
  m.createStep.mockResolvedValue({ id: "note" });
});

describe("POST task runtime repair diagnosis", () => {
  it("requires auth before any ownership, task or runtime inspection", async () => {
    m.auth.mockResolvedValue(null);
    const res = await call().response;
    expect(res.status).toBe(401);
    expect(m.owner).not.toHaveBeenCalled();
    expect(m.task).not.toHaveBeenCalled();
    expect(m.checkpoint).not.toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
  });

  it("requires ownership before inspecting the task, checkpoint or runtime", async () => {
    m.owner.mockRejectedValue(new Error("not owner"));
    expect((await call().response).status).toBe(404);
    expect(m.owner).toHaveBeenCalledWith("project", "owner");
    expect(m.task).not.toHaveBeenCalled();
    expect(m.checkpoint).not.toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
    expect(m.createStep).not.toHaveBeenCalled();
  });

  it("scopes task lookup to the task, project and authenticated project owner", async () => {
    m.task.mockResolvedValue(null);
    expect((await call().response).status).toBe(404);
    expect(m.task).toHaveBeenCalledWith({
      where: { id: "agent-task", projectId: "project", project: { userId: "owner" } },
      select: { message: true },
    });
    expect(m.checkpoint).not.toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
  });

  it("rejects a missing route task ID without doing an unscoped lookup", async () => {
    expect((await call(undefined, "").response).status).toBe(400);
    expect(m.task).not.toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
  });

  it("rejects an in-process task before checkpoint or runtime inspection", async () => {
    runtimeGlobal.graduateStudioAgentControllers?.set("agent-task", {});
    expect((await call().response).status).toBe(409);
    expect(m.checkpoint).not.toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
    expect(m.createStep).not.toHaveBeenCalled();
  });

  it("rejects full mode without running probes", async () => {
    m.checkpoint.mockResolvedValue({ mode: "full" });
    expect((await call().response).status).toBe(400);
    expect(m.collect).not.toHaveBeenCalled();
    expect(m.createStep).not.toHaveBeenCalled();
  });

  it("allows existing business-task failures with no Codex checkpoint", async () => {
    m.checkpoint.mockResolvedValue(null);
    expect((await call().response).status).toBe(200);
    expect(m.collect).toHaveBeenCalledWith("project", storedMessage, expect.any(AbortSignal));
  });

  it("returns 400 for no applicable report, including a stored message with no business task ID", async () => {
    m.task.mockResolvedValue({ message: "普通业务开发需求" });
    m.collect.mockResolvedValue(null);
    expect((await call(JSON.stringify({ prompt: storedMessage })).response).status).toBe(400);
    expect(m.collect).toHaveBeenCalledWith("project", "普通业务开发需求", expect.any(AbortSignal));
    expect(m.lastStep).not.toHaveBeenCalled();
    expect(m.createStep).not.toHaveBeenCalled();
  });

  it("uses only the stored message and request signal, never body prompt, URL or config", async () => {
    const { request, response } = call(
      JSON.stringify({
        prompt: "task #999 repair",
        message: "task #998 error",
        url: "http://malicious.invalid/secret",
        config: { apiKey: "not-forwarded", baseURL: "http://malicious.invalid" },
      }),
    );
    const res = await response;
    expect(res.status).toBe(200);
    expect(request.bodyUsed).toBe(false);
    expect(m.collect).toHaveBeenCalledExactlyOnceWith("project", storedMessage, request.signal);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ report });
    expect(m.lastStep).toHaveBeenCalledWith({
      where: { taskId: "agent-task" },
      orderBy: { index: "desc" },
      select: { index: true },
    });
    expect(m.createStep).toHaveBeenCalledWith({
      data: {
        taskId: "agent-task",
        index: 8,
        kind: "note",
        status: "done",
        title: "运行故障复核",
        detail: "RUNTIME_REPAIR_REPORT\n" + JSON.stringify(report),
        finishedAt: expect.any(Date),
      },
    });
    expect(m.update).not.toHaveBeenCalled();
    expect(m.updateMany).not.toHaveBeenCalled();
    expect(m.saveCheckpoint).not.toHaveBeenCalled();
  });

  it("ignores even malformed JSON and starts at index zero with no prior steps", async () => {
    m.lastStep.mockResolvedValue(null);
    expect((await call("not JSON").response).status).toBe(200);
    expect(m.createStep.mock.calls[0][0].data.index).toBe(0);
  });

  it("returns and appends blocked evidence without claiming repair or mutating the task", async () => {
    const blocked = { ...report, status: "blocked", connectivity: "blocked", taskId: null };
    m.collect.mockResolvedValue(blocked);
    const res = await call().response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report: blocked });
    expect(m.createStep.mock.calls[0][0].data.detail).toBe(
      "RUNTIME_REPAIR_REPORT\n" + JSON.stringify(blocked),
    );
    expect(m.update).not.toHaveBeenCalled();
    expect(m.updateMany).not.toHaveBeenCalled();
    expect(m.saveCheckpoint).not.toHaveBeenCalled();
  });

  it("serializes concurrent diagnosis and releases its lock after success", async () => {
    let finish!: (value: typeof report) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    m.collect.mockImplementationOnce(() => {
      entered();
      return new Promise<typeof report>((resolve) => {
        finish = resolve;
      });
    });
    const first = call().response;
    await started;
    expect((await call().response).status).toBe(409);
    expect(m.collect).toHaveBeenCalledTimes(1);
    finish(report);
    expect((await first).status).toBe(200);
    expect((await call().response).status).toBe(200);
    expect(m.createStep).toHaveBeenCalledTimes(2);
  });

  it("releases the lock after a probe error and does not write a partial note", async () => {
    m.collect.mockRejectedValueOnce(new Error("secret runtime failure"));
    const failed = await call().response;
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain("secret runtime failure");
    expect(m.createStep).not.toHaveBeenCalled();
    expect((await call().response).status).toBe(200);
  });

  it("does not append a note after cancellation or if the task starts during inspection", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await call(undefined, "agent-task", controller.signal).response).status).toBe(500);
    expect(m.createStep).not.toHaveBeenCalled();
    m.collect.mockImplementationOnce(async () => {
      runtimeGlobal.graduateStudioAgentControllers?.set("agent-task", {});
      return report;
    });
    expect((await call().response).status).toBe(409);
    expect(m.createStep).not.toHaveBeenCalled();
  });

  it("has no model, runner, runtime-start, retry or configuration imports", () => {
    const source = readFileSync(
      "src/app/api/projects/[id]/agent-tasks/[taskId]/diagnose/route.ts",
      "utf8",
    );
    const imports = source.match(/^import .* from .*;$/gm)?.join("\n") ?? "";
    expect(imports).not.toMatch(
      /server\/ai|agents\/runner|api-helpers|codex-task|post-apply|process-manager|settings|provider|retry|engine/,
    );
    expect(source).not.toMatch(/db\.agentTask\.(?:update|create|delete)|saveCodexCheckpoint\s*\(/);
  });
});
