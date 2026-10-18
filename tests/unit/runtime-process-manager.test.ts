import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  plan: vi.fn(),
  target: vi.fn(),
  health: vi.fn(),
  activity: vi.fn(),
  occupiedOnce: false,
  python: vi.fn(),
  pythonStart: vi.fn(),
  pythonStop: vi.fn(),
  pythonHealth: vi.fn(),
  exists: vi.fn(),
  read: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
  // Match Node execFile's custom promisify contract ({ stdout, stderr }).
  execFile: Object.assign(mocks.execFile, {
    [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        mocks.execFile(...args, (error: Error | null, stdout: string, stderr: string) =>
          error ? reject(error) : resolve({ stdout, stderr }),
        );
      }),
  }),
}));
vi.mock("node:fs", () => ({
  default: {
    existsSync: mocks.exists,
    readFileSync: mocks.read,
  },
}));
vi.mock("node:net", () => ({
  default: {
    connect: () => {
      const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
      const occupied = mocks.occupiedOnce;
      mocks.occupiedOnce = false;
      queueMicrotask(() =>
        occupied ? socket.emit("connect") : socket.emit("error", new Error("refused")),
      );
      return socket;
    },
    createServer: () => {
      const probe = new EventEmitter() as EventEmitter & {
        listen: () => void;
        close: (fn: () => void) => void;
      };
      probe.listen = () => queueMicrotask(() => probe.emit("listening"));
      probe.close = (fn) => fn();
      return probe;
    },
  },
}));
vi.mock("@/server/workspace/paths", () => ({ resolveProjectDir: () => "/project" }));
vi.mock("@/server/activity", () => ({ logActivity: mocks.activity }));
vi.mock("@/server/runtime/companion-backend", () => ({
  detectBackend: mocks.plan,
  externalApiTarget: mocks.target,
  waitForRuntimeHttp: mocks.health,
}));
vi.mock("@/server/runtime/python-stack", () => ({
  detectPythonStack: mocks.python,
  startPythonStack: mocks.pythonStart,
  stopPythonStack: mocks.pythonStop,
}));
import {
  getRuntimeStatus,
  getLogsSince,
  buildRuntime,
  restartRuntime,
  startRuntime,
  stopRuntime,
} from "@/server/runtime/process-manager";
let children: Array<
  EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; exitCode: null }
>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.python.mockReturnValue(false);
  mocks.pythonStop.mockResolvedValue(undefined);
  mocks.pythonHealth.mockResolvedValue(undefined);
  mocks.pythonStart.mockResolvedValue({
    target: "http://127.0.0.1:4480",
    assertHealthy: mocks.pythonHealth,
  });
  mocks.exists.mockImplementation(
    (p: string) => p.endsWith("package.json") || p.endsWith("node_modules"),
  );
  mocks.read.mockReturnValue('{"scripts":{"dev":"vite"}}');
  children = [];
  mocks.execFile.mockImplementation((_cmd, _args, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    cb?.(null, "", "");
  });
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 100 + children.length,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null,
    });
    children.push(child);
    return child;
  });
  mocks.plan.mockReturnValue({
    directory: "/project/backend",
    script: "start",
    env: { DB_HOST: "project" },
  });
  mocks.target.mockReturnValue(null);
  mocks.health.mockResolvedValue({ ready: true, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("Python fullstack lifecycle", () => {
  it("shares simultaneous starts instead of preparing two Python stacks", async () => {
    mocks.plan.mockReturnValue(null);
    mocks.python.mockReturnValue(true);
    const first = startRuntime("py-concurrent", "user");
    const second = startRuntime("py-concurrent", "user");
    expect(second).toBe(first);
    await first;
    expect(mocks.pythonStart).toHaveBeenCalledOnce();
    await stopRuntime("py-concurrent", "user");
  });
  it("starts data services before frontend and configures both Vite proxy contracts", async () => {
    mocks.plan.mockReturnValue(null);
    mocks.python.mockReturnValue(true);
    const status = await startRuntime("py-stack-ok", "user");
    expect(mocks.pythonStart).toHaveBeenCalledOnce();
    expect(mocks.pythonHealth).toHaveBeenCalledOnce();
    expect(status.backend).toMatchObject({
      stack: "python",
      healthScope: "services",
      ready: true,
      status: "running",
    });
    expect(status.backend?.services).toHaveLength(5);
    const frontend = mocks.spawn.mock.calls.find((c) => c[0] === "npm")!;
    expect(frontend[2].env.VITE_API_PROXY_TARGET).toBe(status.backend?.target);
    expect(frontend[2].env.VITE_DEV_API_TARGET).toBe(status.backend?.target);
    await stopRuntime("py-stack-ok", "user");
    expect(mocks.pythonStop).toHaveBeenCalledWith("py-stack-ok");
    expect(getRuntimeStatus("py-stack-ok").ready).toBe(false);
  });
  it("never launches frontend when Python or database startup fails", async () => {
    mocks.plan.mockReturnValue(null);
    mocks.python.mockReturnValue(true);
    mocks.pythonStart.mockRejectedValueOnce(new Error("isolated database not ready"));
    const status = await startRuntime("py-stack-fail", "user");
    expect(status.status).toBe("failed");
    expect(status.backend?.ready).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.pythonStop).toHaveBeenCalledWith("py-stack-fail");
  });
});
describe("project-local dependency preparation", () => {
  const pkg = {
    scripts: { dev: "vite" },
    dependencies: { vue: "^3.5.0" },
    devDependencies: { vite: "^6.0.0", "@vitejs/plugin-vue": "^5.0.0", typescript: "^5" },
  };
  function setup(missing: string[] = []) {
    mocks.plan.mockReturnValue(null);
    mocks.read.mockReturnValue(JSON.stringify(pkg));
    const absent = new Set(missing);
    mocks.exists.mockImplementation((file: string) => !absent.has(file));
    return absent;
  }
  const local = (...parts: string[]) => path.join("/project", "client", "node_modules", ...parts);

  it("repairs missing declared dev dependencies despite existing node_modules under production", async () => {
    const plugin = local("@vitejs/plugin-vue", "package.json");
    const typescript = local("typescript", "package.json");
    const absent = setup([plugin, typescript]);
    vi.stubEnv("NODE_ENV", "production");
    for (const key of [
      "npm_config_omit",
      "NPM_CONFIG_PRODUCTION",
      "npm_config_only",
      "npm_config_global",
      "NPM_CONFIG_PREFIX",
      "npm_config_dry_run",
      "npm_config_package_lock_only",
      "npm_config_workspace",
    ]) {
      vi.stubEnv(key, "host-value");
    }
    vi.stubEnv("npm_config_registry", "https://registry.example.test");
    mocks.execFile.mockImplementation((_cmd, _args, _options, cb) => {
      absent.clear();
      cb(null, "installed", "");
    });
    const status = await startRuntime("deps-production", "u");
    expect(status.status).toBe("running");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = mocks.execFile.mock.calls[0];
    expect(command).toBe("npm");
    expect(args).toContain("--include=dev");
    expect(args).toContain("--save=false");
    expect(args).not.toContain("vite");
    expect(args).not.toContain("-D");
    expect(options.cwd).toBe(path.join("/project", "client"));
    expect(options.env.NODE_ENV).toBe("development");
    expect(options.env.npm_config_omit).toBeUndefined();
    expect(options.env.NPM_CONFIG_PRODUCTION).toBeUndefined();
    expect(options.env.npm_config_only).toBeUndefined();
    expect(options.env.npm_config_global).toBeUndefined();
    expect(options.env.NPM_CONFIG_PREFIX).toBeUndefined();
    expect(options.env.npm_config_dry_run).toBeUndefined();
    expect(options.env.npm_config_package_lock_only).toBeUndefined();
    expect(options.env.npm_config_workspace).toBeUndefined();
    expect(options.env.npm_config_registry).toBe("https://registry.example.test");
    expect(process.env.NODE_ENV).toBe("production");
    expect(mocks.spawn.mock.calls[0][2].env.NODE_ENV).toBe("development");
    await stopRuntime("deps-production", "u");
  });

  it("does not install when every declared dependency and CLI is local", async () => {
    setup();
    expect((await startRuntime("deps-complete", "u")).status).toBe("running");
    expect(mocks.execFile).not.toHaveBeenCalled();
    await stopRuntime("deps-complete", "u");
  });

  it("fails before spawning when install exits successfully but a local dependency remains missing", async () => {
    setup([local("@vitejs/plugin-vue", "package.json")]);
    expect((await startRuntime("deps-incomplete", "u")).status).toBe("failed");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(
      getLogsSince("deps-incomplete", 0).logs.some((l) => l.text.includes("@vitejs/plugin-vue")),
    ).toBe(true);
  });

  it("never accepts an ancestor/host installation when project-local vite is missing", async () => {
    setup([local("vite", "package.json")]);
    expect((await startRuntime("deps-host", "u")).status).toBe("failed");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("checks local CLI shims even when all package manifests exist", async () => {
    setup([local(".bin", `vite${process.platform === "win32" ? ".cmd" : ""}`)]);
    expect((await startRuntime("deps-bin", "u")).status).toBe("failed");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("propagates install failure without retrying a latest-version single-package install", async () => {
    setup([local("vue", "package.json")]);
    mocks.execFile.mockImplementation((_cmd, _args, _options, cb) =>
      cb(new Error("offline"), "", ""),
    );
    expect((await startRuntime("deps-offline", "u")).status).toBe("failed");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(getLogsSince("deps-offline", 0).logs.some((l) => l.text.includes("offline"))).toBe(true);
    await expect(buildRuntime("deps-build-offline", "u")).rejects.toThrow("offline");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("installs once for a missing node_modules directory", async () => {
    const absent = setup([local(), local("vue", "package.json")]);
    mocks.execFile.mockImplementation((_cmd, _args, _options, cb) => {
      absent.clear();
      cb(null, "installed", "");
    });
    expect((await startRuntime("deps-fresh", "u")).status).toBe("running");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    await stopRuntime("deps-fresh", "u");
  });

  it("allows npm's absent platform-specific optional dependencies", async () => {
    setup([local("fsevents", "package.json")]);
    mocks.read.mockReturnValue(
      JSON.stringify({
        ...pkg,
        dependencies: { ...pkg.dependencies, fsevents: "^2" },
        optionalDependencies: { fsevents: "^2" },
      }),
    );
    expect((await startRuntime("deps-optional", "u")).status).toBe("running");
    expect(mocks.execFile).not.toHaveBeenCalled();
    await stopRuntime("deps-optional", "u");
  });

  it("rejects dependency names that escape project node_modules", async () => {
    setup();
    mocks.read.mockReturnValue(JSON.stringify({ dependencies: { "../vite": "^6" } }));
    expect((await startRuntime("deps-traversal", "u")).status).toBe("failed");
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("warns that an unmanaged Python backend is not started without fabricating readiness", async () => {
    mocks.plan.mockReturnValue(null);
    mocks.exists.mockImplementation(
      (p: string) =>
        p.endsWith("package.json") || p.endsWith("node_modules") || p.endsWith("requirements.txt"),
    );
    const status = await startRuntime("deps-python-warning", "u");
    expect(status.backend).toBeNull();
    expect(status.ready).toBe(true);
    expect(
      getLogsSince("deps-python-warning", 0).logs.some((l) => l.text.includes("当前仅启动前端")),
    ).toBe(true);
    await stopRuntime("deps-python-warning", "u");
  });
});

describe("managed fullstack runtime", () => {
  it("skips a TCP-occupied port even when Windows bind probing would succeed", async () => {
    mocks.plan.mockReturnValue(null);
    const project = "manager-collision";
    let hash = 0;
    for (const ch of project) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const base = 4400 + (hash % 90);
    mocks.occupiedOnce = true;
    const status = await startRuntime(project, "u");
    expect(status.port).toBe(base + 1);
    await stopRuntime(project, "u");
  });
  it("stop cancels in-flight backend health without starting a client", async () => {
    let resolveHealth!: (value: { ready: boolean; error: null }) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.health.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        resolveHealth = resolve;
      });
    });
    const start = startRuntime("manager-cancel", "u");
    await waiting;
    const stop = stopRuntime("manager-cancel", "u");
    resolveHealth({ ready: true, error: null });
    await stop;
    expect((await start).status).toBe("stopped");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it("restarts owned companion and ignores late callbacks from the old run", async () => {
    await startRuntime("manager-restart", "u");
    const old = children.slice();
    await restartRuntime("manager-restart", "u");
    old[0].emit("exit", 1);
    old[1].emit("exit", 1);
    expect(getRuntimeStatus("manager-restart").status).toBe("running");
    expect(mocks.spawn).toHaveBeenCalledTimes(4);
    await stopRuntime("manager-restart", "u");
  });
  it("starts backend before client and injects allocated API target", async () => {
    const status = await startRuntime("manager-start", "u");
    expect(status.status).toBe("running");
    expect(status.ready).toBe(true);
    expect(status.backend).toMatchObject({ managed: true, status: "running", healthScope: "http" });
    expect(mocks.spawn.mock.calls[0][1]).toEqual(["run", "start"]);
    const backendEnv = mocks.spawn.mock.calls[0][2].env;
    expect(backendEnv.APP_PORT).toBe(backendEnv.PORT);
    expect(mocks.spawn.mock.calls[1][2].env.VITE_DEV_API_TARGET).toBe(status.backend?.target);
    await stopRuntime("manager-start", "u");
    expect(getRuntimeStatus("manager-start").ready).toBe(false);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });
  it("health-checks external targets without owning or killing them", async () => {
    mocks.target.mockReturnValue("http://127.0.0.1:8181");
    const status = await startRuntime("manager-external", "u");
    expect(status.backend?.managed).toBe(false);
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    await stopRuntime("manager-external", "u");
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });
  it("does not report running on frontend HTTP timeout", async () => {
    mocks.health
      .mockResolvedValueOnce({ ready: true, error: null })
      .mockResolvedValueOnce({ ready: false, error: "HTTP timeout" });
    expect((await startRuntime("manager-timeout", "u")).status).toBe("failed");
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });
  it("surfaces backend health failure before launching frontend", async () => {
    mocks.health.mockResolvedValue({ ready: false, error: "HTTP 503" });
    const status = await startRuntime("manager-unhealthy", "u");
    expect(status.status).toBe("failed");
    expect(status.backend?.error).toBe("HTTP 503");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it("marks runtime failed and stops client when managed backend exits", async () => {
    await startRuntime("manager-exit", "u");
    children[0].emit("exit", 1);
    expect(getRuntimeStatus("manager-exit").status).toBe("failed");
    expect(getRuntimeStatus("manager-exit").ready).toBe(false);
    await stopRuntime("manager-exit", "u");
  });
});
