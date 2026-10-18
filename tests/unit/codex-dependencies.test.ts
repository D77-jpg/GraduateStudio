import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
  failRun: false,
  hangRun: false,
  cleanupFails: false,
  onRun: undefined as (() => void) | undefined,
}));
vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
    state.calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("close", null));
        return true;
      }),
    });
    queueMicrotask(() => {
      if (args[0] === "run") {
        state.onRun?.();
        if (state.hangRun) return;
      }
      if (args[0] === "image")
        child.stdout.write(JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, Os: "linux" }));
      if (args[0] === "ps" && state.cleanupFails) child.stdout.write("leftover-container");
      child.stdout.end();
      child.stderr.end();
      child.emit("close", args[0] === "run" && state.failRun ? 1 : 0);
    });
    return child;
  }),
}));
import {
  CODEX_DEPENDENCY_TIMEOUT_MS,
  prepareCodexDependencies,
  validateCodexDependencyLock,
} from "../../src/server/agents/codex-dependencies";

const dirs: string[] = [];
const manifest = {
  name: "safe-project",
  version: "1.0.0",
  dependencies: { example: "^1.0.0" },
  scripts: { preinstall: "touch /host-pwned" },
};
function lock() {
  return {
    lockfileVersion: 3,
    packages: {
      "": { ...manifest },
      "node_modules/example": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
        integrity: `sha512-${"A".repeat(86)}==`,
        hasInstallScript: true,
      },
    },
  };
}
async function fixture(roots = [""]) {
  const stage = await mkdtemp(path.join(tmpdir(), "gs-deps-test-"));
  dirs.push(stage);
  for (const root of roots) {
    await mkdir(path.join(stage, root), { recursive: true });
    await writeFile(path.join(stage, root, "package.json"), JSON.stringify(manifest));
    await writeFile(path.join(stage, root, "package-lock.json"), JSON.stringify(lock()));
  }
  return stage;
}
async function cache() {
  const dir = await mkdtemp(path.join(tmpdir(), "gs-trusted-cache-test-"));
  dirs.push(dir);
  await mkdir(path.join(dir, "_cacache"));
  vi.stubEnv("GS_CODEX_NPM_CACHE", dir);
  return dir;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  state.calls = [];
  state.failRun = false;
  state.hangRun = false;
  state.cleanupFails = false;
  state.onRun = undefined;
});

describe("isolated Codex dependency lock policy", () => {
  it("allows strong-integrity registry locks and scripts only as skipped metadata", () => {
    expect(() => validateCodexDependencyLock(manifest, lock())).not.toThrow();
  });
  it.each([
    "http://registry.npmjs.org/x.tgz",
    "https://evil.test/x.tgz",
    "https://registry.npmjs.org:444/x.tgz",
    "https://user:secret@registry.npmjs.org/x.tgz",
    "file:../x",
    "git+https://registry.npmjs.org/x.tgz",
  ])("refuses resolution %s", (url) => {
    const data = lock();
    data.packages["node_modules/example"].resolved = url;
    expect(() => validateCodexDependencyLock(manifest, data)).toThrow();
  });
  it.each([
    "file:../x",
    "../x",
    "git+https://github.com/a/b",
    "https://registry.npmjs.org/x.tgz",
    "github:a/b",
    "npm:other@1",
    "workspace:*",
  ])("refuses dependency spec %s", (spec) => {
    expect(() => validateCodexDependencyLock({ dependencies: { x: spec } }, lock())).toThrow();
  });
  it("requires supported lock version, integrity, safe package paths, and no workspaces", () => {
    expect(() =>
      validateCodexDependencyLock(manifest, { ...lock(), lockfileVersion: 1 }),
    ).toThrow();
    const data = lock();
    data.packages["node_modules/example"].integrity = "sha1-abc";
    expect(() => validateCodexDependencyLock(manifest, data)).toThrow();
    expect(() =>
      validateCodexDependencyLock(manifest, {
        ...lock(),
        packages: { "": {}, "../node_modules/x": {} },
      }),
    ).toThrow();
    expect(() => validateCodexDependencyLock({ workspaces: ["client"] }, lock())).toThrow();
  });
});
describe("offline platform preparation", () => {
  it("uses the controlled dependency proxy when no offline cache is configured", async () => {
    vi.stubEnv("GS_CODEX_NPM_CACHE", "");
    const result = await prepareCodexDependencies(await fixture());
    expect(result.status).toBe("passed");
    expect(result.isolation).toBe("docker-internal-network-controlled-proxy");
    const runs = state.calls.filter((call) => call.args[0] === "run");
    expect(runs).toHaveLength(1);
    // The installer joins the temporary internal network, never the default route,
    // and no offline cache is mounted when no trusted cache is configured.
    expect(runs[0].args).toContain("--network");
    const network = runs[0].args[runs[0].args.indexOf("--network") + 1];
    expect(network).toMatch(/^gs-codex-deps-/);
    expect(runs[0].args.join(" ")).not.toContain("dst=/cache");
    expect(runs[0].args.join(" ")).not.toMatch(
      /docker\.sock|--privileged|--env|\/broker|\/bin\/sh/,
    );
    expect(state.calls.some((c) => c.args[0] === "network" && c.args[1] === "create")).toBe(true);
    expect(state.calls.some((c) => c.args[0] === "network" && c.args[1] === "rm")).toBe(true);
    expect(state.calls.some((c) => c.args[0] === "rm" && c.args.includes("--force"))).toBe(true);
  });
  it("still refuses unsafe manifests when no cache is configured", async () => {
    vi.stubEnv("GS_CODEX_NPM_CACHE", "");
    const stage = await mkdtemp(path.join(tmpdir(), "gs-deps-test-"));
    dirs.push(stage);
    await writeFile(
      path.join(stage, "package.json"),
      JSON.stringify({ name: "unsafe", version: "1.0.0", dependencies: { evil: "file:../x" } }),
    );
    const result = await prepareCodexDependencies(stage);
    expect(result.status).toBe("blocked");
    expect(result.roots[0].installed).toBe(false);
    expect(state.calls.filter((call) => call.args[0] === "run")).toHaveLength(0);
  });
  it("requires lockfiles even with cache and never generates one", async () => {
    const stage = await fixture();
    await cache();
    await rm(path.join(stage, "package-lock.json"));
    expect((await prepareCodexDependencies(stage)).status).toBe("blocked");
    expect(state.calls).toEqual([]);
  });
  it("does not report pass when no package/install exists", async () => {
    expect((await prepareCodexDependencies(await fixture([]))).status).toBe("blocked");
    expect(state.calls).toEqual([]);
  });
  it("uses only pinned Docker with read-only input/cache and constrained output, with no credentials or project npmrc", async () => {
    const stage = await fixture(["", "client", "backend", "server", "unsupported"]);
    const trustedCache = await cache();
    await writeFile(path.join(stage, ".npmrc"), "registry=http://127.0.0.1:1234\n");
    const before = await readFile(path.join(stage, "package.json"), "utf8");
    const result = await prepareCodexDependencies(stage);
    expect(result.status).toBe("passed");
    expect(result.roots.map((r) => r.root)).toEqual(["", "client", "backend", "server"]);
    const runs = state.calls.filter((call) => call.args[0] === "run");
    expect(runs).toHaveLength(4);
    for (const { command, args, options } of runs) {
      expect(command).toBe("docker");
      expect(options.shell).toBe(false);
      expect(args).toEqual(
        expect.arrayContaining([
          "--pull",
          "never",
          "--network",
          "none",
          "--read-only",
          "--user",
          "10001:10001",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--tmpfs",
          "--entrypoint",
          "/usr/local/bin/node",
          `sha256:${"a".repeat(64)}`,
        ]),
      );
      expect(args).toContain(`type=bind,src=${trustedCache},dst=/cache,readonly`);
      expect(args.filter((a) => a.startsWith("type=bind"))).toHaveLength(3);
      expect(args.some((a) => a.endsWith("dst=/input,readonly"))).toBe(true);
      expect(args.some((a) => a.endsWith("dst=/output"))).toBe(true);
      expect(args.join(" ")).not.toMatch(/docker\.sock|--privileged|--env|\/broker|\/bin\/sh/);
      const bootstrap = args.at(-1)!;
      expect(bootstrap).toContain("'ci','--ignore-scripts','--offline'");
      expect(bootstrap).toContain("--registry=https://registry.npmjs.org");
      expect(bootstrap).toContain("--userconfig=/tmp/npmrc-user");
      expect(bootstrap).toContain("--globalconfig=/tmp/npmrc-global");
      expect(bootstrap).not.toContain(".npmrc");
      expect(bootstrap).toContain("fs.cp('/cache/_cacache', '/tmp/cache/_cacache'");
    }
    expect(await readFile(path.join(stage, "package.json"), "utf8")).toBe(before);
    expect(state.calls.filter((call) => call.args[0] === "rm")).toHaveLength(4);
    expect(state.calls.filter((call) => call.args[0] === "ps")).toHaveLength(4);
  });
  it("fails on npm cache miss/nonzero and never treats absence as successful installation", async () => {
    state.failRun = true;
    const stage = await fixture();
    await cache();
    const result = await prepareCodexDependencies(stage);
    expect(result.status).toBe("failed");
    expect(result.roots[0].installed).toBe(false);
    expect(state.calls.some((call) => call.args[0] === "rm")).toBe(true);
  });
  it("kills/removes an aborted container independently of cancelled signal", async () => {
    const stage = await fixture();
    await cache();
    const ctrl = new AbortController();
    state.hangRun = true;
    state.onRun = () => ctrl.abort();
    const result = await prepareCodexDependencies(stage, ctrl.signal);
    expect(result.status).toBe("failed");
    expect(result.roots[0].installed).toBe(false);
    expect(state.calls.some((call) => call.args[0] === "rm" && call.args[1] === "--force")).toBe(
      true,
    );
    expect(state.calls.some((call) => call.args[0] === "ps")).toBe(true);
  });
  it("rejects already-aborted preparation before Docker", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect((await prepareCodexDependencies(await fixture(), ctrl.signal)).status).toBe("failed");
    expect(state.calls).toEqual([]);
  });
  it("times out then force-removes container", async () => {
    const stage = await fixture();
    await cache();
    state.hangRun = true;
    const original = globalThis.setTimeout;
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        original(fn, ms === CODEX_DEPENDENCY_TIMEOUT_MS ? 5 : ms, ...args)) as typeof setTimeout);
    try {
      const result = await prepareCodexDependencies(stage);
      expect(result.status).toBe("failed");
      expect(timer).toHaveBeenCalledWith(expect.any(Function), 600_000);
      expect(state.calls.some((call) => call.args[0] === "rm")).toBe(true);
    } finally {
      timer.mockRestore();
    }
  });
  it("does not pass if container removal cannot be verified", async () => {
    state.cleanupFails = true;
    await cache();
    const result = await prepareCodexDependencies(await fixture());
    expect(result.status).toBe("failed");
    expect(result.roots[0].installed).toBe(false);
  });
});
