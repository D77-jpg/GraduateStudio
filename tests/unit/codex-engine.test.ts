import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CodexEngine } from "@/server/agents/adapters/codex";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.pid = 0; // Never target a real host process in unit tests.
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit("exit", 143);
  return child as unknown as ChildProcess;
}

describe("Codex JSONL engine adapter", () => {
  it("maps lifecycle and message events without touching the workspace", async () => {
    const child = fakeChild();
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const engine = new CodexEngine((command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      queueMicrotask(() => {
        child.stdout!.emit(
          "data",
          Buffer.from(
            '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.started"}\n{"type":"message.delta","delta":"OK"}\n',
          ),
        );
        child.stdout!.emit("data", Buffer.from('{"type":"turn.completed"}\n'));
        child.emit("exit", 0);
        child.emit("close", 0, null);
      });
      return child;
    });
    const events: string[] = [];
    const result = await engine.run(
      {
        projectId: "p",
        workspace: ".",
        prompt: "read only",
        mode: "read-only",
        allowedPaths: ["client/**"],
      },
      (event) => events.push(event.type),
    );
    expect(result.exitCode).toBe(0);
    expect(result.threadId).toBe("t1");
    expect(result.lastMessage).toBe("OK");
    expect(events).toEqual([
      "run.started",
      "thread.started",
      "turn.started",
      "message.delta",
      "run.completed",
    ]);
    expect(calls[0].args).toContain("--json");
    expect(calls[0].args).toContain("read-only");
  });

  it("reports revoked-auth JSONL errors and nonzero exits", async () => {
    const child = fakeChild();
    const engine = new CodexEngine(() => {
      queueMicrotask(() => {
        child.stdout!.emit(
          "data",
          Buffer.from(
            '{"type":"error","message":"refresh token revoked"}\n{"type":"turn.failed","error":{"message":"refresh token revoked"}}\n',
          ),
        );
        child.emit("exit", 1);
        child.emit("close", 1, null);
      });
      return child;
    });
    const errors: string[] = [];
    const result = await engine.run(
      { projectId: "p", workspace: ".", prompt: "probe" },
      (event) => {
        if (event.type === "error") errors.push(event.message);
      },
    );
    expect(result.exitCode).toBe(1);
    expect(errors).toEqual([
      "Codex authentication failed (refresh token revoked or credentials expired); sign in again.",
    ]);
  });
});
