import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CodexEngine } from "@/server/agents/adapters/codex";
import type { AgentEngineEvent } from "@/server/agents/engine";

const task = { projectId: "p", workspace: ".", prompt: "test only" };
function setup(timeout = 10000) {
  const child = Object.assign(new EventEmitter(), {
    pid: 0,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  const events: AgentEngineEvent[] = [];
  const spawn = vi.fn(() => child as unknown as ChildProcess);
  const engine = new CodexEngine(spawn, timeout);
  const frame = (value: unknown) =>
    child.stdout.emit("data", Buffer.from(JSON.stringify(value) + "\n"));
  return { child, events, engine, spawn, frame };
}

afterEach(() => vi.useRealTimers());

describe("Codex process lifecycle hardening (no real CLI)", () => {
  it("settles only close and consumes output after exit", async () => {
    const { child, engine, events, frame } = setup();
    let settled = false;
    const running = engine
      .run(task, (event) => events.push(event))
      .then((result) => {
        settled = true;
        return result;
      });
    child.emit("exit", 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    frame({ type: "message.delta", delta: "last pipe data" });
    frame({ type: "turn.completed" });
    child.emit("close", 0, null);
    expect((await running).lastMessage).toBe("last pipe data");
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("retains native crash evidence when the last JSON frame is truncated", async () => {
    const { child, engine, events } = setup();
    const running = engine.run(task, (event) => events.push(event));
    child.stdout.emit("data", Buffer.from('{"type":"item.completed","item":'));
    child.stderr.emit("data", Buffer.from("thread 'main' panicked at writer: sk-SECRET"));
    child.emit("close", 101, null);
    expect((await running).exitCode).toBe(101);
    const last = events.at(-1);
    expect(last).toMatchObject({
      type: "run.failed",
      message: expect.stringContaining("native process crashed"),
    });
    expect(JSON.stringify(last)).toContain("tail=unclosed");
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("rejects exit zero without terminal completion", async () => {
    const { child, engine, events } = setup();
    const running = engine.run(task, (event) => events.push(event));
    child.emit("close", 0, null);
    expect((await running).exitCode).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      message: expect.stringContaining("turn.completed"),
    });
  });

  it("does not turn stderr warnings into errors or leak raw stderr", async () => {
    const { child, engine, events, frame } = setup();
    const running = engine.run(task, (event) => events.push(event));
    child.stderr.emit("data", Buffer.from("Bearer sk-SECRET private reasoning warning"));
    frame({ type: "turn.completed" });
    child.emit("close", 0, null);
    expect((await running).exitCode).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.completed"]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("nonzero exit carries safe actionable diagnostics", async () => {
    const { child, engine, events } = setup();
    const running = engine.run(task, (event) => events.push(event));
    child.stderr.emit("data", Buffer.from("refresh token revoked sk-SECRET"));
    child.emit("close", 7, null);
    expect((await running).exitCode).toBe(7);
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      message: expect.stringContaining("sign in again"),
    });
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("turn.failed cannot be reported successful even when process exits zero", async () => {
    const { child, engine, events, frame } = setup();
    const running = engine.run(task, (event) => events.push(event));
    frame({ type: "turn.failed", error: { message: "quota exceeded" } });
    child.emit("close", 0, null);
    expect((await running).exitCode).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      message: expect.stringContaining("quota"),
    });
  });

  it("aborts before spawn and handles synchronous spawn errors without raw details", async () => {
    const { engine, spawn } = setup();
    const controller = new AbortController();
    controller.abort();
    expect((await engine.run({ ...task, signal: controller.signal })).exitCode).toBe(130);
    expect(spawn).not.toHaveBeenCalled();
    const events: AgentEngineEvent[] = [];
    const broken = new CodexEngine(() => {
      throw new Error("sk-SECRET");
    });
    expect((await broken.run(task, (event) => events.push(event))).exitCode).toBe(1);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("waits for close on asynchronous process error", async () => {
    const { child, engine } = setup();
    let settled = false;
    const running = engine.run(task).then((value) => {
      settled = true;
      return value;
    });
    child.emit("error", new Error("secret"));
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", -2, null);
    expect((await running).exitCode).toBe(1);
  });

  it.each(["timeout", "signal", "cancel"])(
    "%s waits for close and emits only one terminal failure",
    async (mode) => {
      vi.useFakeTimers();
      const { child, engine, events } = setup(20);
      const controller = new AbortController();
      let settled = false;
      const running = engine
        .run({ ...task, signal: controller.signal }, (event) => events.push(event))
        .then((value) => {
          settled = true;
          return value;
        });
      let cancel: Promise<void> | undefined;
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(21);
      else if (mode === "signal") controller.abort();
      else cancel = engine.cancel(events[0].runId);
      await Promise.resolve();
      expect(settled).toBe(false);
      child.emit("exit", null, "SIGTERM");
      child.emit("close", null, "SIGTERM");
      expect((await running).exitCode).toBe(mode === "timeout" ? 124 : 130);
      await cancel;
      expect(events.filter((event) => event.type === "run.failed")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("malformed final frame fails without leaking raw input", async () => {
    const { child, engine, events } = setup();
    const running = engine.run(task, (event) => events.push(event));
    child.stdout.emit("data", Buffer.from("sk-SECRET invalid JSON"));
    child.emit("close", 0, null);
    expect((await running).exitCode).toBe(1);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });
});
