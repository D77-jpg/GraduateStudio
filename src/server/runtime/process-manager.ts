import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { resolveProjectDir } from "@/server/workspace/paths";
import { logActivity } from "@/server/activity";
import { detectBackend, externalApiTarget, waitForRuntimeHttp } from "./companion-backend";
import { detectPythonStack, startPythonStack, stopPythonStack } from "./python-stack";
import { frontendRuntimeEnvironment } from "./runtime-environment";

/**
 * Phase 6:项目 Runtime 进程管理器。
 * 真实启动用户项目的 dev server(子进程),提供:启动/停止/重启/一次性构建、
 * 稳定端口分配(占用自动顺延)、依赖自愈(node_modules 缺失自动 npm install)、
 * 环形日志缓冲(stdout/stderr 合流,支持增量拉取)、进程状态与退出码。
 * 日志保存在内存(进程停止即清空);启动/停止事件写入 ActivityLog。
 */

const execFileAsync = promisify(execFile);

export class ErNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErNotConfiguredError";
  }
}

export type RuntimeStatus = "stopped" | "starting" | "running" | "exited" | "failed" | "building";

interface LogEntry {
  seq: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

interface RuntimeProcess {
  projectId: string;
  proc: ChildProcess | null;
  buildProc: ChildProcess | null;
  backendProc: ChildProcess | null;
  backend: BackendStatusInfo | null;
  generation: number;
  startupAbort?: AbortController;
  pythonStack?: { target: string; assertHealthy: () => Promise<void> };
  healthTimer?: ReturnType<typeof setInterval>;
  healthChecking?: boolean;
  cleanupPromise?: Promise<void>;
  port: number;
  status: RuntimeStatus;
  exitCode: number | null;
  startedAt: number | null;
  logs: LogEntry[];
  nextSeq: number;
  ready: boolean;
  building: boolean;
}

const processes = new Map<string, RuntimeProcess>();
const MAX_LOGS = 2000;
const PORT_BASE = 4400;
const PORT_RANGE = 90;

function appendLog(rp: RuntimeProcess, stream: LogEntry["stream"], text: string): void {
  const trimmed = text.replace(/\r/g, "");
  if (!trimmed.trim()) return;
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    rp.logs.push({ seq: rp.nextSeq++, stream, text: line.slice(0, 500) });
  }
  if (rp.logs.length > MAX_LOGS) {
    rp.logs.splice(0, rp.logs.length - MAX_LOGS);
  }
}

/** 端口分配:项目稳定基口 + 占用顺延探测 */
async function allocatePort(projectId: string): Promise<number> {
  let hash = 0;
  for (const ch of projectId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  let port = PORT_BASE + (hash % PORT_RANGE);
  for (let i = 0; i < 10; i++) {
    const availableOn = (host: string) =>
      new Promise<boolean>((resolve) => {
        const probe = net.createServer();
        probe.once("error", (error: NodeJS.ErrnoException) =>
          resolve(host === "::1" && error.code === "EAFNOSUPPORT"),
        );
        probe.once("listening", () => probe.close(() => resolve(true)));
        probe.listen({ port, host, exclusive: true });
      });
    const occupiedOn = (host: string) =>
      new Promise<boolean>((resolve) => {
        const socket = net.connect({ port, host });
        const done = (occupied: boolean) => {
          socket.destroy();
          resolve(occupied);
        };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        socket.setTimeout(500, () => done(true)); // Uncertain occupancy is not safe to reuse.
      });
    // Windows reuse semantics can allow bind probes despite an existing listener.
    const occupied = (await occupiedOn("127.0.0.1")) || (await occupiedOn("::1"));
    const free = !occupied && (await availableOn("127.0.0.1")) && (await availableOn("::1"));
    if (free) return port;
    port = port >= PORT_BASE + PORT_RANGE ? PORT_BASE : port + 1;
  }
  throw new Error("No free runtime port available.");
}

function getOrCreate(projectId: string): RuntimeProcess {
  let rp = processes.get(projectId);
  if (!rp) {
    rp = {
      projectId,
      proc: null,
      buildProc: null,
      backendProc: null,
      backend: null,
      generation: 0,
      port: 0,
      status: "stopped",
      exitCode: null,
      startedAt: null,
      logs: [],
      nextSeq: 1,
      ready: false,
      building: false,
    };
    processes.set(projectId, rp);
  }
  return rp;
}

/** Windows 下杀整棵进程树 */
async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true }).catch(
      () => {},
    );
  } else {
    // Runtime children start in their own process group on POSIX.
    await execFileAsync("kill", ["-9", "--", `-${pid}`]).catch(() =>
      execFileAsync("kill", ["-9", String(pid)]).catch(() => {}),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BackendStatusInfo {
  managed: boolean;
  target: string;
  pid: number | null;
  status: "starting" | "running" | "failed" | "stopped";
  ready: boolean;
  error: string | null;
  /** Python stacks additionally verify the isolated database, cache and workers. */
  healthScope: "http" | "services";
  stack?: "python";
  services?: Array<{ name: string; status: "starting" | "running" | "failed" | "stopped" }>;
}

export interface RuntimeStatusInfo {
  ready: boolean;
  backend: BackendStatusInfo | null;
  status: RuntimeStatus;
  port: number | null;
  pid: number | null;
  previewUrl: string | null;
  startedAt: number | null;
  uptimeSec: number | null;
  exitCode: number | null;
  building: boolean;
}

export function getRuntimeStatus(projectId: string): RuntimeStatusInfo {
  const rp = processes.get(projectId);
  if (!rp || (rp.status === "stopped" && !rp.proc)) {
    return {
      status: "stopped",
      ready: false,
      backend: rp?.backend ?? null,
      port: null,
      pid: null,
      previewUrl: null,
      startedAt: null,
      uptimeSec: null,
      exitCode: null,
      building: false,
    };
  }
  return {
    status: rp.building ? "building" : rp.status,
    ready: rp.ready,
    backend: rp.backend,
    port: rp.port || null,
    pid: rp.proc?.pid ?? null,
    previewUrl: rp.status === "running" ? `http://localhost:${rp.port}` : null,
    startedAt: rp.startedAt,
    uptimeSec: rp.startedAt ? Math.round((Date.now() - rp.startedAt) / 1000) : null,
    exitCode: rp.exitCode,
    building: rp.building,
  };
}

export function getLogsSince(
  projectId: string,
  since: number,
): { logs: LogEntry[]; nextSeq: number; status: RuntimeStatusInfo } {
  const rp = getOrCreate(projectId);
  const logs = rp.logs.filter((l) => l.seq > since);
  return { logs, nextSeq: rp.nextSeq, status: getRuntimeStatus(projectId) };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 检查项目自身的全部运行/开发依赖;不从宿主或祖先 node_modules 借包。 */
async function ensureDeps(
  rp: RuntimeProcess,
  _projectDir: string,
  clientDir: string,
): Promise<void> {
  const clientNodeModules = path.join(clientDir, "node_modules");
  const pkgPath = path.join(clientDir, "package.json");
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  // npm permits optional packages to be absent (e.g. platform-specific packages).
  const declared = new Set(
    [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].filter(
      (name) => !Object.hasOwn(pkg.optionalDependencies ?? {}, name),
    ),
  );
  for (const name of declared) {
    // Never let a manifest key escape node_modules, including on Windows.
    if (
      !/^(?:@[^/\\]+\/)?[^/\\]+$/.test(name) ||
      name.split("/").some((part) => part === "." || part === ".." || part.includes(":"))
    ) {
      throw new Error(`Invalid dependency name: ${name}`);
    }
  }
  const binName = (pkg.scripts?.dev ?? "").trim().split(/\s+/)[0];
  const binPath = path.join(
    clientNodeModules,
    ".bin",
    binName + (process.platform === "win32" ? ".cmd" : ""),
  );
  const missingDeps = () => {
    const missing = [...declared].filter(
      (name) => !fs.existsSync(path.join(clientNodeModules, name, "package.json")),
    );
    // Preserve support for old scripts, but never satisfy their CLI via host PATH.
    if (declared.has(binName) && !fs.existsSync(binPath)) missing.push(`.bin/${binName}`);
    return missing;
  };
  const missing = missingDeps();
  if (fs.existsSync(clientNodeModules) && missing.length === 0) return;

  appendLog(
    rp,
    "system",
    `[runtime] 项目依赖缺失(${missing.join(", ") || "node_modules"}),自动执行 npm install…`,
  );
  // A production Next host and npm-run's lower-case npm_config_* must not omit
  // devDependencies, redirect installation globally, or turn it into a dry run.
  // Keep registry/proxy routing without exposing platform credentials to project programs.
  const env: NodeJS.ProcessEnv = { ...frontendRuntimeEnvironment() };
  // npm registry routing is not passed to project dev scripts.
  for (const [key, value] of Object.entries(process.env))
    if (/^npm_config_registry$/i.test(key)) env[key] = value;
  for (const key of Object.keys(env)) {
    if (
      /^npm_config_(?:omit|include|production|only|also|global|prefix|location|workspace|workspaces|dry_run|package_lock_only|bin_links|save)$/i.test(
        key,
      )
    ) {
      delete env[key];
    }
  }
  try {
    const { stdout } = await execFileAsync(
      "npm",
      [
        "install",
        "--include=dev",
        "--include=prod",
        "--production=false",
        "--global=false",
        "--workspaces=false",
        "--dry-run=false",
        "--package-lock-only=false",
        "--bin-links=true",
        "--save=false",
        "--no-audit",
        "--no-fund",
        "--loglevel",
        "error",
      ],
      {
        cwd: clientDir,
        env,
        timeout: 600_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        shell: process.platform === "win32",
      },
    );
    appendLog(rp, "system", `[runtime] npm install 完成\n${stdout.slice(0, 500)}`);
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(`npm install 失败:${clip(err.stderr || err.message || "", 800)}`);
  }
  // npm exit 0 is not proof: omission/configuration or an incomplete installation
  // can leave required packages missing. Fail before executing any project script.
  const remaining = missingDeps();
  if (remaining.length) {
    throw new Error(`npm install 后项目依赖仍缺失:${remaining.join(", ")}`);
  }
}

const startupOperations = new Map<string, Promise<RuntimeStatusInfo>>();
const stoppingOperations = new Map<string, Promise<RuntimeStatusInfo>>();
/** Same-project starts share one operation; stop waits for its aborted cleanup before a restart. */
export function startRuntime(projectId: string, userId: string): Promise<RuntimeStatusInfo> {
  const pending = startupOperations.get(projectId);
  if (pending) return pending;
  const stopping = stoppingOperations.get(projectId);
  if (stopping) return stopping.then(() => startRuntime(projectId, userId));
  const operation = startRuntimeInternal(projectId, userId)
    .catch((error) => {
      const rp = processes.get(projectId);
      if (rp) {
        rp.status = "failed";
        rp.ready = false;
        appendLog(rp, "system", "[runtime] 启动未完成，请查看服务准备阶段或重试。");
      }
      throw error;
    })
    .finally(() => {
      if (startupOperations.get(projectId) === operation) startupOperations.delete(projectId);
    });
  startupOperations.set(projectId, operation);
  return operation;
}
/** 启动项目 dev server(真实子进程)。 */
async function startRuntimeInternal(projectId: string, userId: string): Promise<RuntimeStatusInfo> {
  void userId; // 归属校验在路由层完成
  const rp = getOrCreate(projectId);
  if (rp.cleanupPromise) await rp.cleanupPromise;
  if (rp.status === "running" || rp.status === "starting") return getRuntimeStatus(projectId);
  // Reserve state synchronously before cleanup to make status truthful during slow Docker cleanup.
  rp.status = "starting";
  rp.ready = false;
  // Clean up failed attempts before retrying; never leave a companion process behind.
  rp.startupAbort?.abort();
  const generation = ++rp.generation;
  const startupAbort = new AbortController();
  rp.startupAbort = startupAbort;
  const cancelled = () => rp.generation !== generation || rp.status === "stopped";
  if (rp.healthTimer) clearInterval(rp.healthTimer);
  rp.healthTimer = undefined;
  if (rp.pythonStack || detectPythonStack(resolveProjectDir(projectId)))
    await stopPythonStack(projectId);
  rp.pythonStack = undefined;
  if (rp.proc?.pid) await killTree(rp.proc.pid);
  if (rp.backendProc?.pid) await killTree(rp.backendProc.pid);
  rp.proc = null;
  rp.backendProc = null;
  rp.backend = null;
  if (cancelled()) return getRuntimeStatus(projectId);

  const projectDir = resolveProjectDir(projectId);
  const clientDir = path.join(projectDir, "client");
  if (!fs.existsSync(path.join(clientDir, "package.json"))) {
    rp.status = "failed";
    appendLog(
      rp,
      "system",
      "[runtime] 启动失败:未找到 client/package.json(请先在工作区生成前端项目)",
    );
    throw new ErNotConfiguredError("未找到 client/package.json,无法启动(需要前端项目)");
  }

  rp.status = "starting";
  rp.ready = false;
  rp.exitCode = null;
  rp.startedAt = Date.now();
  appendLog(rp, "system", `[runtime] 正在启动项目…`);

  let apiTarget: string | null = null;
  try {
    await ensureDeps(rp, projectDir, clientDir);
    if (cancelled()) return getRuntimeStatus(projectId);
    apiTarget = externalApiTarget(projectDir);
    const plan = apiTarget ? null : detectBackend(projectDir);
    if (!apiTarget && !plan && detectPythonStack(projectDir)) {
      const backendPort = await allocatePort(`${projectId}:python`);
      apiTarget = `http://127.0.0.1:${backendPort}`;
      rp.backend = {
        managed: true,
        target: apiTarget,
        pid: null,
        status: "starting",
        ready: false,
        error: null,
        healthScope: "services",
        stack: "python",
        services: ["MySQL", "Redis", "FastAPI", "Worker", "Beat"].map((name) => ({
          name,
          status: "starting",
        })),
      };
      rp.pythonStack = await startPythonStack({
        projectId,
        projectDir,
        port: backendPort,
        signal: startupAbort.signal,
        log: (message) => appendLog(rp, "system", message),
      });
      if (cancelled()) {
        await stopPythonStack(projectId);
        return getRuntimeStatus(projectId);
      }
      await rp.pythonStack.assertHealthy();
      rp.backend.ready = true;
      rp.backend.status = "running";
      rp.backend.services = rp.backend.services?.map((service) => ({
        ...service,
        status: "running",
      }));
    } else if (plan) {
      await ensureDeps(rp, projectDir, plan.directory);
      if (cancelled()) return getRuntimeStatus(projectId);
      const backendPort = await allocatePort(`${projectId}:backend`);
      apiTarget = `http://127.0.0.1:${backendPort}`;
      rp.backend = {
        managed: true,
        target: apiTarget,
        pid: null,
        status: "starting",
        ready: false,
        error: null,
        healthScope: "http",
      };
      const backendProc = spawn("npm", ["run", plan.script], {
        cwd: plan.directory,
        env: {
          ...plan.env,
          PORT: String(backendPort),
          APP_PORT: String(backendPort),
          HOST: "127.0.0.1",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        shell: process.platform === "win32",
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      rp.backendProc = backendProc;
      rp.backend.pid = backendProc.pid ?? null;
      appendLog(
        rp,
        "system",
        `[backend] npm run ${plan.script}, target ${apiTarget}; HTTP health does not verify database prerequisites.`,
      );
      backendProc.stdout?.on("data", (chunk: Buffer) =>
        appendLog(rp, "stdout", `[backend] ${chunk.toString("utf8")}`),
      );
      backendProc.stderr?.on("data", (chunk: Buffer) =>
        appendLog(rp, "stderr", `[backend] ${chunk.toString("utf8")}`),
      );
      const backendFailed = (message: string) => {
        if (rp.backendProc !== backendProc || cancelled()) return;
        rp.backend!.status = "failed";
        rp.backend!.ready = false;
        rp.backend!.error = message;
        rp.ready = false;
        rp.status = "failed";
        appendLog(
          rp,
          "system",
          `[backend] ${message}; check backend logs and project .env prerequisites.`,
        );
        if (rp.proc?.pid) void killTree(rp.proc.pid);
      };
      backendProc.on("error", (error) => backendFailed(`Spawn failed: ${error.message}`));
      backendProc.on("exit", (code) => backendFailed(`Backend exited (${code})`));
    } else if (apiTarget) {
      rp.backend = {
        managed: false,
        target: apiTarget,
        pid: null,
        status: "starting",
        ready: false,
        error: null,
        healthScope: "http",
      };
      appendLog(
        rp,
        "system",
        `[backend] 使用项目显式配置的外部后端 ${apiTarget}; runtime 不负责停止该服务。`,
      );
    }
    if (!plan && !apiTarget) {
      const serverDir = path.join(projectDir, "server");
      if (
        ["requirements.txt", "requirements-dev.txt", "pyproject.toml"].some((file) =>
          fs.existsSync(path.join(serverDir, file)),
        )
      ) {
        appendLog(
          rp,
          "system",
          "[runtime] 当前仅启动前端；Python 后端尚未配置/启动，页面可预览不代表接口可用。",
        );
      }
    }
    if (apiTarget && !rp.pythonStack) {
      const health = await waitForRuntimeHttp(
        `${apiTarget}/api/health`,
        45000,
        () => cancelled() || rp.status === "failed",
        true,
      );
      if (cancelled()) return getRuntimeStatus(projectId);
      const backendReady = health.ready && getRuntimeStatus(projectId).status !== "failed";
      rp.backend!.ready = backendReady;
      rp.backend!.status = backendReady ? "running" : "failed";
      rp.backend!.error = health.error ?? rp.backend!.error;
      if (!backendReady)
        throw new Error(
          `Backend HTTP health failed: ${rp.backend!.error}. Check project .env and backend prerequisites.`,
        );
    }
  } catch (error) {
    if (cancelled()) return getRuntimeStatus(projectId);
    rp.status = "failed";
    rp.ready = false;
    appendLog(
      rp,
      "system",
      `[runtime] ${error instanceof Error ? error.message : "Backend startup failed"}`,
    );
    if (rp.backendProc?.pid) await killTree(rp.backendProc.pid);
    if (rp.backend?.stack === "python") {
      rp.backend.status = "failed";
      rp.backend.ready = false;
      rp.backend.error = error instanceof Error ? error.message : "Python stack startup failed";
      rp.backend.services = rp.backend.services?.map((service) => ({
        ...service,
        status: "failed",
      }));
      await stopPythonStack(projectId);
      rp.pythonStack = undefined;
    }
    return getRuntimeStatus(projectId);
  }
  if (cancelled()) return getRuntimeStatus(projectId);

  // Never adopt an arbitrary port listener: it may be a different project or stale API proxy.
  let port: number;
  try {
    port = await allocatePort(projectId);
  } catch (error) {
    rp.status = "failed";
    rp.ready = false;
    if (rp.pythonStack) await stopPythonStack(projectId);
    throw error;
  }
  if (cancelled()) return getRuntimeStatus(projectId);
  rp.port = port;

  const proc = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: clientDir,
    env: {
      ...frontendRuntimeEnvironment(),
      NODE_ENV: "development",
      PORT: String(port),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      BROWSER: "none",
      ...(apiTarget
        ? { VITE_DEV_API_TARGET: apiTarget, VITE_API_PROXY_TARGET: apiTarget, VITE_DEV_PROXY: "on" }
        : {}),
    },
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  rp.proc = proc;

  appendLog(
    rp,
    "system",
    `[runtime] dev server 启动中: npm run dev --prefix client -- --port ${port} --strictPort (PID ${proc.pid})`,
  );

  proc.stdout?.on("data", (chunk: Buffer) => appendLog(rp, "stdout", chunk.toString("utf8")));
  proc.stderr?.on("data", (chunk: Buffer) => appendLog(rp, "stderr", chunk.toString("utf8")));
  proc.on("error", (error) => {
    if (rp.proc !== proc || cancelled()) return;
    rp.status = "failed";
    rp.ready = false;
    appendLog(rp, "system", `[runtime] Spawn failed: ${error.message}`);
  });
  proc.on("exit", (code) => {
    if (rp.proc !== proc || cancelled()) return;
    rp.ready = false;
    if (rp.backendProc?.pid) void killTree(rp.backendProc.pid);
    rp.exitCode = code;
    if (rp.status !== "stopped") {
      rp.status = code === 0 ? "exited" : "failed";
      appendLog(rp, "system", `[runtime] 进程退出,exit code = ${code}`);
    }
    rp.proc = null;
    if (rp.healthTimer) clearInterval(rp.healthTimer);
    if (rp.pythonStack && !rp.cleanupPromise) {
      const cleanup = stopPythonStack(projectId)
        .catch(() => appendLog(rp, "system", "[runtime] Python cleanup failed; retry Stop."))
        .finally(() => {
          if (rp.cleanupPromise === cleanup) rp.cleanupPromise = undefined;
        });
      rp.cleanupPromise = cleanup;
    }
  });

  const health = await waitForRuntimeHttp(
    `http://localhost:${port}/`,
    45000,
    () => cancelled() || rp.status === "failed" || !rp.proc,
  );
  if (cancelled()) return getRuntimeStatus(projectId);
  if (health.ready && rp.proc && getRuntimeStatus(projectId).status !== "failed") {
    rp.status = "running";
    rp.ready = true;
    appendLog(rp, "system", `[runtime] 项目已启动:http://localhost:${port}`);
    if (rp.pythonStack) {
      rp.healthTimer = setInterval(() => {
        if (rp.healthChecking || cancelled() || !rp.pythonStack) return;
        rp.healthChecking = true;
        void rp.pythonStack
          .assertHealthy()
          .catch(async (error) => {
            if (cancelled()) return;
            rp.ready = false;
            rp.status = "failed";
            if (rp.backend) {
              rp.backend.ready = false;
              rp.backend.status = "failed";
              rp.backend.error = String(error);
              rp.backend.services = rp.backend.services?.map((service) => ({
                ...service,
                status: "failed",
              }));
            }
            appendLog(rp, "system", `[runtime] 全栈健康检查失败: ${String(error)}`);
            if (rp.healthTimer) clearInterval(rp.healthTimer);
            const failedPid = rp.proc?.pid;
            const cleanup = (async () => {
              if (failedPid) await killTree(failedPid);
              if (!cancelled()) await stopPythonStack(projectId);
            })()
              .catch(() => appendLog(rp, "system", "[runtime] Failed stack cleanup; retry Stop."))
              .finally(() => {
                if (rp.cleanupPromise === cleanup) rp.cleanupPromise = undefined;
              });
            rp.cleanupPromise = cleanup;
            await cleanup;
          })
          .finally(() => {
            rp.healthChecking = false;
          });
      }, 15000);
      rp.healthTimer.unref?.();
    }
    await logActivity(projectId, "system", `项目启动:http://localhost:${port}`);
  } else {
    rp.status = "failed";
    rp.ready = false;
    appendLog(rp, "system", `[runtime] Frontend HTTP readiness failed: ${health.error}`);
    if (rp.pythonStack) await stopPythonStack(projectId);
    if (rp.proc?.pid) await killTree(rp.proc.pid);
    if (rp.backendProc?.pid) await killTree(rp.backendProc.pid);
  }
  return getRuntimeStatus(projectId);
}

export function stopRuntime(projectId: string, userId: string): Promise<RuntimeStatusInfo> {
  const pending = stoppingOperations.get(projectId);
  if (pending) return pending;
  const operation = stopRuntimeInternal(projectId, userId).finally(() => {
    if (stoppingOperations.get(projectId) === operation) stoppingOperations.delete(projectId);
  });
  stoppingOperations.set(projectId, operation);
  return operation;
}
async function stopRuntimeInternal(projectId: string, userId: string): Promise<RuntimeStatusInfo> {
  void userId; // 归属校验在路由层完成
  const rp = processes.get(projectId);
  if (!rp) {
    if (detectPythonStack(resolveProjectDir(projectId))) await stopPythonStack(projectId);
    return getRuntimeStatus(projectId);
  }
  rp.status = "stopped";
  ++rp.generation;
  rp.startupAbort?.abort();
  const pendingStartup = startupOperations.get(projectId);
  if (pendingStartup) await pendingStartup.catch(() => {});
  if (rp.cleanupPromise) await rp.cleanupPromise;
  if (rp.healthTimer) clearInterval(rp.healthTimer);
  rp.healthTimer = undefined;
  if (rp.pythonStack || detectPythonStack(resolveProjectDir(projectId)))
    await stopPythonStack(projectId);
  rp.pythonStack = undefined;
  if (rp.backendProc?.pid) await killTree(rp.backendProc.pid);
  rp.backendProc = null;
  if (rp.backend) {
    rp.backend.status = "stopped";
    rp.backend.ready = false;
    rp.backend.pid = null;
    rp.backend.services = rp.backend.services?.map((service) => ({
      ...service,
      status: "stopped",
    }));
  }
  if (rp.buildProc) {
    try {
      rp.buildProc.kill();
    } catch {
      /* 已退出 */
    }
    rp.buildProc = null;
    rp.building = false;
  }
  if (rp.proc?.pid) {
    appendLog(rp, "system", `[runtime] 停止项目(PID ${rp.proc.pid})`);
    await killTree(rp.proc.pid);
  }
  rp.proc = null;
  rp.ready = false;
  await logActivity(projectId, "system", "项目停止");
  return getRuntimeStatus(projectId);
}

export async function restartRuntime(
  projectId: string,
  userId: string,
): Promise<RuntimeStatusInfo> {
  void userId; // 归属校验在路由层完成
  const rp = processes.get(projectId);
  if (rp) {
    await stopRuntime(projectId, userId);
    await sleep(800);
  }
  return startRuntime(projectId, userId);
}

/** 一次性构建(输出进入同一日志流;不阻断 dev server)。 */
export async function buildRuntime(projectId: string, userId: string): Promise<RuntimeStatusInfo> {
  void userId; // 归属校验在路由层完成
  const rp = getOrCreate(projectId);
  if (rp.building) return getRuntimeStatus(projectId);
  const projectDir = resolveProjectDir(projectId);
  const clientDir = path.join(projectDir, "client");
  if (!fs.existsSync(path.join(clientDir, "package.json"))) {
    throw new ErNotConfiguredError("未找到 client/package.json");
  }
  await ensureDeps(rp, projectDir, clientDir);

  rp.building = true;
  appendLog(rp, "system", "[build] 开始构建(npm run build)…");
  const buildProc = spawn("npm", ["run", "build"], {
    cwd: clientDir,
    env: { ...frontendRuntimeEnvironment(), FORCE_COLOR: "0", NO_COLOR: "1" },
    shell: true,
    windowsHide: true,
  });
  rp.buildProc = buildProc;

  buildProc.stdout?.on("data", (chunk: Buffer) => appendLog(rp, "stdout", chunk.toString("utf8")));
  buildProc.stderr?.on("data", (chunk: Buffer) => appendLog(rp, "stderr", chunk.toString("utf8")));
  buildProc.on("exit", (code) => {
    rp.building = false;
    rp.buildProc = null;
    appendLog(rp, "system", `[build] 构建${code === 0 ? "成功" : `失败,exit code = ${code}`}`);
    void logActivity(projectId, "system", `项目构建${code === 0 ? "成功" : "失败"}`);
  });
  return getRuntimeStatus(projectId);
}
