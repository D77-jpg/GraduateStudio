import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({
  calls: [] as { args: string[]; options: Record<string, unknown> }[],
  missing: false,
  removed: new Set<string>(),
  resultCode: 0,
  transportStatus: "",
  gatewayState: "true 0",
  probeFails: false,
  clearFails: false,
}));
vi.mock("node:child_process", () => ({
  spawn: vi.fn((_command: string, args: string[], options: Record<string, unknown>) => {
    state.calls.push({ args, options });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      pid: 123,
    });
    queueMicrotask(() => {
      let code = 0;
      if (args[0] === "image") {
        if (state.missing) code = 1;
        else
          child.stdout.write(
            JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, Os: "linux", Config: {} }),
          );
      } else if (args[0] === "rm") state.removed.add(args.at(-1)!);
      else if (args[1] === "rm") state.removed.add(args.at(-1)!);
      else if (args[0] === "inspect") child.stdout.write(state.gatewayState);
      else if (args[0] === "exec" && args.at(-1)?.includes("readFileSync")) {
        if (state.probeFails) code = 1;
        else child.stdout.write(state.transportStatus);
      } else if (args[0] === "exec" && args.at(-1)?.includes("rmSync") && state.clearFails)
        code = 1;
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
    });
    return child;
  }),
}));
vi.mock("../../src/server/agents/adapters/codex", () => ({
  CodexEngine: class {
    id = "codex";
    constructor(public spawn: (command: string, args: string[]) => EventEmitter) {}
    async run(task: { workspace: string; mode?: string }) {
      const child = this.spawn("host-codex-must-not-run", [
        "exec",
        "-c",
        "mcp_servers.cnki-search.enabled=false",
        "--sandbox",
        task.mode ?? "workspace-write",
        "--cd",
        task.workspace,
      ]);
      await new Promise((resolve) => child.once("close", resolve));
      return { runId: "stub-run", exitCode: state.resultCode, lastMessage: "normal agent answer" };
    }
  },
}));
vi.mock("../../src/server/agents/design-skill-bundle", () => ({
  verifyDesignSkillBundle: async () => ({
    root: "/reviewed/design-skills",
    revision: "b".repeat(64),
    skills: [
      { id: "ui-ux-pro-max", revision: "c".repeat(40) },
      { id: "frontend-design", revision: "d".repeat(40) },
    ],
  }),
}));
import {
  cleanupCodexStage,
  createIsolatedCodexEngine,
} from "../../src/server/agents/codex-container";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.unstubAllEnvs();
  state.calls = [];
  state.missing = false;
  state.removed.clear();
  state.resultCode = 0;
  state.transportStatus = "";
  state.gatewayState = "true 0";
  state.probeFails = false;
  state.clearFails = false;
});
async function stage() {
  const dir = await mkdtemp(path.join(tmpdir(), "gs-isolation-test-"));
  dirs.push(dir);
  return dir;
}

describe("isolated Codex lifecycle", () => {
  it("fails closed if the pinned local image is absent; never pulls or starts host Codex", async () => {
    vi.stubEnv("GS_CODEX_API_KEY", "test-secret");
    state.missing = true;
    await expect(createIsolatedCodexEngine(await stage())).rejects.toThrow("No host fallback");
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].args.slice(0, 3)).toEqual([
      "image",
      "inspect",
      "gs-codex-worker:0.150.1",
    ]);
  });
  it("puts the credential only in gateway env, never argv or metadata, and disposes idempotently", async () => {
    vi.stubEnv("GS_CODEX_API_KEY", "test-super-secret");
    const isolated = await createIsolatedCodexEngine(await stage());
    expect(isolated.metadata).toEqual({
      model: "deepseek-flash",
      isolation: "docker-linux-network-none-unix-broker",
      image: "gs-codex-worker:0.150.1",
      toolchainFallback: false,
      designSkillsRevision: "b".repeat(64),
      designSkills: [
        { id: "ui-ux-pro-max", revision: "c".repeat(40) },
        { id: "frontend-design", revision: "d".repeat(40) },
      ],
    });
    const run = state.calls.find((call) => call.args[0] === "run")!;
    expect(run.args).toContain("GS_BROKER_KEY");
    expect(run.args).toContain("--read-only");
    expect(JSON.stringify(state.calls.map((call) => call.args))).not.toContain("test-super-secret");
    expect((run.options.env as Record<string, string>).GS_BROKER_KEY).toBe("test-super-secret");
    await isolated.dispose();
    const count = state.calls.length;
    await isolated.dispose();
    expect(state.calls).toHaveLength(count);
    expect(state.calls.some((call) => call.args[0] === "volume" && call.args[1] === "rm")).toBe(
      true,
    );
    expect(state.calls.some((call) => call.args[0] === "network" && call.args[1] === "rm")).toBe(
      true,
    );
  });
  it("runs only a network-none Docker worker with translated cwd and read-only stage", async () => {
    vi.stubEnv("GS_CODEX_API_KEY", "test-secret");
    const dir = await stage();
    const isolated = await createIsolatedCodexEngine(dir);
    await isolated.engine.run({
      projectId: "test",
      workspace: dir,
      prompt: "unused",
      mode: "read-only",
    });
    const worker = state.calls.find(
      (call) => call.args[0] === "run" && call.args[call.args.indexOf("--network") + 1] === "none",
    )!;
    expect(worker.args[worker.args.indexOf("--network") + 1]).toBe("none");
    expect(worker.args[worker.args.indexOf("--cd") + 1]).toBe("/workspace");
    expect(worker.args).toContain(`type=bind,src=${dir},dst=/workspace,readonly`);
    expect(worker.args.some((arg) => arg.includes("dst=/config,readonly"))).toBe(true);
    expect(worker.args).toContain(
      "type=bind,src=/reviewed/design-skills,dst=/opt/gs-design-skills,readonly",
    );
    expect(worker.args).not.toContain("host-codex-must-not-run");
    expect(worker.args[worker.args.indexOf("--label") + 1]).toMatch(
      /^io\.graduatestudio\.codex\.stage=[a-f0-9]{64}$/,
    );
    expect(worker.args.some((arg) => arg.startsWith("mcp_servers."))).toBe(false);
    expect(worker.args[worker.args.indexOf("--sandbox") + 1]).toBe("danger-full-access");
    await isolated.dispose();
  });
  it.each([401, 403, 408, 413, 429, 500, 502, 503, 504])(
    "emits a safe status-specific failure for broker HTTP %s without changing lastMessage",
    async (status) => {
      vi.stubEnv("GS_CODEX_API_KEY", "test-secret");
      state.resultCode = 1;
      state.transportStatus = `UPSTREAM_HTTP_${status}`;
      const dir = await stage();
      const isolated = await createIsolatedCodexEngine(dir);
      const events: unknown[] = [];
      const result = await isolated.engine.run(
        { projectId: "test", workspace: dir, prompt: "unused" },
        (event) => events.push(event),
      );
      expect(result.lastMessage).toBe("normal agent answer");
      expect(events).toEqual([
        expect.objectContaining({
          type: "error",
          message: expect.stringContaining(`UPSTREAM_HTTP_${status}`),
        }),
      ]);
      expect(JSON.stringify(events)).not.toMatch(/test-secret|协议/);
      await isolated.dispose();
    },
  );
  it.each([
    ["false 124", true, "BROKER_LIFETIME_EXPIRED"],
    ["false 1", true, "BROKER_STOPPED"],
    ["true 0", true, null],
    ["private-inspect-error 124", true, null],
    ["false 124", false, "BROKER_LIFETIME_EXPIRED"],
  ])(
    "checks fixed gateway state %s after failed transport probe",
    async (gatewayState, probeFails, expected) => {
      vi.stubEnv("GS_CODEX_API_KEY", "test-secret");
      state.resultCode = 1;
      state.gatewayState = gatewayState;
      state.probeFails = probeFails;
      const dir = await stage();
      const isolated = await createIsolatedCodexEngine(dir);
      const events: unknown[] = [];
      await isolated.engine.run({ projectId: "test", workspace: dir, prompt: "unused" }, (event) =>
        events.push(event),
      );
      if (expected)
        expect(events).toEqual([
          expect.objectContaining({ message: expect.stringContaining(expected) }),
        ]);
      else expect(events).toEqual([]);
      expect(JSON.stringify(events)).not.toContain("private-inspect-error");
      const gateway = state.calls.find((call) => call.args.includes("--detach"))!;
      expect(gateway.args).not.toContain("--rm");
      expect(
        state.calls.some(
          (call) =>
            call.args[0] === "inspect" &&
            call.args.includes("{{.State.Running}} {{.State.ExitCode}}"),
        ),
      ).toBe(true);
      await isolated.dispose();
    },
  );
  it("diagnoses a gateway that expired between turns without launching a worker", async () => {
    vi.stubEnv("GS_CODEX_API_KEY", "test-secret");
    const dir = await stage();
    const isolated = await createIsolatedCodexEngine(dir);
    state.clearFails = true;
    state.gatewayState = "false 124";
    await expect(
      isolated.engine.run({ projectId: "test", workspace: dir, prompt: "unused" }),
    ).rejects.toThrow("BROKER_LIFETIME_EXPIRED");
    expect(state.calls.filter((call) => call.args[0] === "run")).toHaveLength(1);
    await isolated.dispose();
  });
  it("rejects non-allowlisted transport payloads without leaking secrets or statuses", async () => {
    vi.stubEnv("GS_CODEX_API_KEY", "test-secret");
    state.resultCode = 1;
    state.transportStatus = "UPSTREAM_HTTP_502 Bearer sk-secret";
    const dir = await stage();
    const isolated = await createIsolatedCodexEngine(dir);
    const events: unknown[] = [];
    await isolated.engine.run({ projectId: "test", workspace: dir, prompt: "unused" }, (event) =>
      events.push(event),
    );
    expect(events).toEqual([]);
    await isolated.dispose();
  });
  it("scopes explicit orphan cleanup to the exact hashed canonical stage label", async () => {
    await cleanupCodexStage(await stage());
    expect(state.calls).toHaveLength(6);
    for (const call of state.calls) {
      expect(call.args).toContain("--filter");
      expect(call.args[call.args.indexOf("--filter") + 1]).toMatch(
        /^label=io\.graduatestudio\.codex\.stage=[a-f0-9]{64}$/,
      );
    }
  });
  it.each(["127.0.0.1", "10.0.0.1", "198.18.0.250", "169.254.169.254", "::1"])(
    "rejects nonpublic upstream pin %s",
    async (ip) => {
      vi.stubEnv("GS_CODEX_UPSTREAM_IP", ip);
      await expect(createIsolatedCodexEngine(await stage())).rejects.toThrow("public IPv4");
      expect(state.calls).toHaveLength(0);
    },
  );
  it("rejects insecure upstreams before starting Docker", async () => {
    vi.stubEnv("GS_CODEX_BASE_URL", "http://127.0.0.1:8080");
    await expect(createIsolatedCodexEngine(await stage())).rejects.toThrow("HTTPS");
    expect(state.calls).toHaveLength(0);
  });
});
