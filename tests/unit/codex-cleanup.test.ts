import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { CodexEngine } from "@/server/agents/adapters/codex";
import type { AgentEngineEvent } from "@/server/agents/engine";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("kills process trees, escalates after grace, and waits for process and tree-killer close", async () => {
  vi.useFakeTimers();
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const killers: EventEmitter[] = [];
  vi.mocked(spawn).mockImplementation(() => {
    const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
    killers.push(killer);
    return killer as unknown as ChildProcess;
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 987654,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  const engine = new CodexEngine(() => child as unknown as ChildProcess);
  const events: AgentEngineEvent[] = [];
  let settled = false;
  const running = engine
    .run({ projectId: "p", workspace: ".", prompt: "mock" }, (event) => events.push(event))
    .then((value) => {
      settled = true;
      return value;
    });
  const cancelled = engine.cancel(events[0].runId);
  await vi.advanceTimersByTimeAsync(1001);
  expect(settled).toBe(false);
  if (process.platform === "win32") {
    expect(spawn).toHaveBeenCalledWith(
      "taskkill",
      ["/F", "/T", "/PID", "987654"],
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(killers).toHaveLength(2);
  } else {
    expect(kill).toHaveBeenCalledWith(-987654, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-987654, "SIGKILL");
  }
  child.emit("close", null, "SIGTERM");
  if (killers.length) {
    await Promise.resolve();
    expect(settled).toBe(false);
    for (const killer of killers) killer.emit("close", 0);
  }
  expect((await running).exitCode).toBe(130);
  await cancelled;
  expect(vi.getTimerCount()).toBe(0);
});

describe("native process group fallback", () => {
  it.skipIf(process.platform === "win32")(
    "falls back to direct child kill when no process group exists",
    async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("ESRCH");
      });
      const child = Object.assign(new EventEmitter(), {
        pid: 987654,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      const engine = new CodexEngine(() => child as unknown as ChildProcess);
      let runId = "";
      const running = engine.run({ projectId: "p", workspace: ".", prompt: "mock" }, (event) => {
        runId = event.runId;
      });
      const cancelled = engine.cancel(runId);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      child.emit("close", null, "SIGTERM");
      await running;
      await cancelled;
    },
  );
});
