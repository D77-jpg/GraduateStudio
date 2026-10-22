import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; options: Record<string, unknown> }>,
  output: "Tests 2 passed",
  code: 0,
  missing: false,
  cleanup: false,
  hold: false,
  killed: false,
  removeResolved: false,
  child: null as null | (EventEmitter & { kill: () => void }),
}));
vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
    expect(command).toBe("docker");
    state.calls.push({ args, options });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        state.killed = true;
        queueMicrotask(() => child.emit("close", null));
        return true;
      },
    });
    queueMicrotask(() => {
      if (args[0] === "start" && state.hold) {
        state.child = child;
        return;
      }
      let code = 0;
      if (args[0] === "image") {
        if (state.missing) code = 1;
        else child.stdout.write(JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, Os: "linux" }));
      }
      if (args[0] === "start") {
        child.stdout.write(state.output);
        code = state.code;
      }
      if (args[0] === "inspect")
        child.stdout.write(JSON.stringify({ Running: false, ExitCode: state.code }));
      if (args[0] === "ps" && state.cleanup) child.stdout.write("still-running");
      if (args[0] === "rm") state.removeResolved = true;
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
    });
    return child;
  }),
}));
import { runCodexAcceptance } from "../../src/server/agents/codex-acceptance";
const dirs: string[] = [];
async function stage(
  manifest: Record<string, unknown> = { scripts: { build: "build-tool", test: "test-tool" } },
  root = "",
) {
  const dir = await mkdtemp(path.join(tmpdir(), "gs-acceptance-test-"));
  dirs.push(dir);
  await mkdir(path.join(dir, root), { recursive: true });
  await writeFile(path.join(dir, root, "package.json"), JSON.stringify(manifest));
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  Object.assign(state, {
    calls: [],
    output: "Tests 2 passed",
    code: 0,
    missing: false,
    cleanup: false,
    hold: false,
    killed: false,
    removeResolved: false,
    child: null,
  });
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("independent isolated engineering verification", () => {
  it("runs only declared fixed npm scripts in hardened offline containers with no key, config or socket", async () => {
    vi.stubEnv("GS_CODEX_API_KEY", "sensitive-key");
    vi.stubEnv("DOCKER_HOST", "tcp://unsafe-host");
    const dir = await stage();
    const result = await runCodexAcceptance(dir);
    expect(result.status).toBe("passed");
    expect(result.checks.map((check) => check.command)).toEqual(["npm run build", "npm run test"]);
    for (const check of result.checks) expect(check.durationMs).toBeGreaterThanOrEqual(0);
    const creates = state.calls.filter((c) => c.args[0] === "create");
    expect(creates).toHaveLength(2);
    expect(creates.map((c) => c.args.slice(-2))).toEqual([
      ["run", "build"],
      ["run", "test"],
    ]);
    for (const { args, options } of creates) {
      for (const flag of [
        "--read-only",
        "--cap-drop",
        "--pids-limit",
        "--memory",
        "--cpus",
        "--tmpfs",
      ])
        expect(args).toContain(flag);
      expect(args[args.indexOf("--network") + 1]).toBe("none");
      expect(args[args.indexOf("--user") + 1]).toBe("10001:10001");
      expect(args[args.indexOf("--entrypoint") + 1]).toBe("npm");
      expect(args.filter((a) => a.startsWith("type=bind"))).toEqual([
        `type=bind,src=${dir},dst=/workspace`,
      ]);
      expect(args).toContain("CI=true");
      expect(args).toContain("npm_config_offline=true");
      expect(JSON.stringify(args)).not.toMatch(
        /sensitive-key|\/config|\/broker|docker\.sock|--if-present|--runInBand/,
      );
      expect(options.env).not.toHaveProperty("GS_CODEX_API_KEY");
      expect(options.env).not.toHaveProperty("DOCKER_HOST");
      expect(options.shell).toBe(false);
    }
    const names = creates.map((c) => c.args[c.args.indexOf("--name") + 1]);
    expect(state.calls.filter((c) => c.args[0] === "rm").map((c) => c.args.at(-1))).toEqual(names);
    expect(new Set(names).size).toBe(2);
  });
  it("does not install missing dependencies or turn absent scripts into success", async () => {
    const dir = await stage({ scripts: { build: "vite build" }, dependencies: { vite: "*" } });
    await writeFile(path.join(dir, "package-lock.json"), "{}");
    const result = await runCodexAcceptance(dir);
    expect(result.status).toBe("blocked");
    expect(result.checks.map((c) => c.status)).toEqual(["blocked", "not_run"]);
    expect(state.calls).toHaveLength(0);
    expect((await runCodexAcceptance(await stage({ scripts: { lint: "echo okay" } }))).status).toBe(
      "blocked",
    );
    expect(state.calls).toHaveLength(0);
  });
  it("accepts trusted prepared node_modules but still blocks missing executables", async () => {
    const dir = await stage({ scripts: { build: "vite build" }, dependencies: { vite: "*" } });
    await mkdir(path.join(dir, "node_modules"));
    state.output = "sh: vite: not found";
    state.code = 127;
    const result = await runCodexAcceptance(dir);
    expect(result.status).toBe("blocked");
    expect(result.checks[0].exitCode).toBe(127);
  });
  it("fails closed on unavailable worker image without pulling or host fallback", async () => {
    state.missing = true;
    const result = await runCodexAcceptance(await stage());
    expect(result.status).toBe("blocked");
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].args.slice(0, 3)).toEqual([
      "image",
      "inspect",
      "gs-codex-worker:0.150.1",
    ]);
  });
  it.each([
    "No tests found",
    "# tests 0\n# pass 0",
    "Tests 3 skipped",
    "Tests 2 passed (1 skipped)",
    "all good",
    "",
  ])("blocks ambiguous or empty test evidence: %s", async (output) => {
    state.output = output;
    expect((await runCodexAcceptance(await stage({ scripts: { test: "test-tool" } }))).status).toBe(
      "blocked",
    );
  });
  it.each([
    "Tests 2 passed",
    "# tests 2\n# pass 2",
    "ℹ tests 2\nℹ pass 2",
    "2 passing (10ms)",
    "ok 1 - useful test",
  ])("recognizes executed test evidence: %s", async (output) => {
    state.output = output;
    expect((await runCodexAcceptance(await stage({ scripts: { test: "test-tool" } }))).status).toBe(
      "passed",
    );
  });
  it("reports nonzero assertions as failed, redacts output and bounds storage", async () => {
    state.code = 1;
    state.output = "Tests 1 failed\nBearer test-secret\napi_key=secret-value\n" + "x".repeat(20000);
    const result = await runCodexAcceptance(await stage({ scripts: { test: "test-tool" } }));
    expect(result.status).toBe("failed");
    const check = result.checks.find((c) => c.name === ".:test")!;
    expect(check.exitCode).toBe(1);
    expect(check.output.length).toBeLessThanOrEqual(16384);
    expect(check.output).not.toMatch(/test-secret|secret-value/);
  });
  it("checks only fixed manifest roots and never interpolates manifest script contents into Docker arguments", async () => {
    const dir = await stage({ scripts: { build: "echo unsafe; curl malicious" } }, "client");
    await mkdir(path.join(dir, "arbitrary"));
    await writeFile(path.join(dir, "arbitrary/package.json"), '{"scripts":{"test":"dangerous"}}');
    expect((await runCodexAcceptance(dir)).status).toBe("passed");
    const call = state.calls.find((c) => c.args[0] === "create")!;
    expect(call.args).toContain("/workspace/client");
    expect(call.args.join(" ")).not.toMatch(/unsafe|malicious|dangerous/);
  });
  it("awaits exact-name cleanup and confirmation when cancelled", async () => {
    state.hold = true;
    const controller = new AbortController();
    const pending = runCodexAcceptance(
      await stage({ scripts: { test: "test-tool" } }),
      controller.signal,
    );
    // Let bounded filesystem + mocked Docker startup finish, then cancel the attached client.
    await vi.waitFor(() => expect(state.child).not.toBeNull());
    expect(state.child).not.toBeNull();
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("blocked");
    expect(state.killed).toBe(true);
    expect(state.removeResolved).toBe(true);
    expect(state.calls.at(-1)?.args[0]).toBe("ps");
    expect(state.calls.some((c) => c.args.includes("stop") || c.args.includes("prune"))).toBe(
      false,
    );
  });
  it("blocks a lost Docker client and awaits cleanup without passing", async () => {
    state.hold = true;
    const pending = runCodexAcceptance(await stage({ scripts: { test: "test-tool" } }));
    await vi.waitFor(() => expect(state.child).not.toBeNull());
    // An unexpected client termination must not be interpreted as command success.
    state.child!.kill();
    const result = await pending;
    expect(result.status).toBe("blocked");
    expect(state.removeResolved).toBe(true);
  });
  it("blocks no-tests-found even when the runner exits nonzero", async () => {
    state.code = 1;
    state.output = "No test files found, exiting with code 1";
    expect((await runCodexAcceptance(await stage({ scripts: { test: "test-tool" } }))).status).toBe(
      "blocked",
    );
  });
  it("does not mistake a node test runner's zero skipped count for skipped tests", async () => {
    state.output = "# tests 2\n# pass 2\n# skipped 0\n# todo 0";
    expect(
      (await runCodexAcceptance(await stage({ scripts: { test: "node --test" } }))).status,
    ).toBe("passed");
  });
  it("blocks results if removal cannot be verified", async () => {
    state.cleanup = true;
    const result = await runCodexAcceptance(await stage());
    expect(result.status).toBe("blocked");
    expect(result.checks.every((c) => c.output.includes("cleanup"))).toBe(true);
  });
  it("rejects invalid manifests and already cancelled requests without running generated code", async () => {
    const dir = await stage();
    await writeFile(path.join(dir, "package.json"), "not json");
    expect((await runCodexAcceptance(dir)).status).toBe("blocked");
    const controller = new AbortController();
    controller.abort();
    expect((await runCodexAcceptance(dir, controller.signal)).status).toBe("blocked");
    expect(state.calls).toHaveLength(0);
  });
});

describe("regression: 2026-10-17 full task reported passed with an unverified Spring Boot backend", () => {
  it("never reports passed when a non-Node project exists that npm checks cannot verify", async () => {
    const dir = await stage({ scripts: { build: "vite build", test: "vitest run" } }, "client");
    await mkdir(path.join(dir, "client", "node_modules"), { recursive: true });
    await mkdir(path.join(dir, "server"), { recursive: true });
    await writeFile(path.join(dir, "server", "pom.xml"), "<project><artifactId>spring-boot</artifactId></project>");
    const result = await runCodexAcceptance(dir);
    expect(result.checks.find((c) => c.name === "client:build")?.status).toBe("passed");
    expect(result.checks.find((c) => c.name === "server:maven:unverified")?.status).toBe("blocked");
    expect(result.status).toBe("blocked");
  });
});
