import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { resolveProjectDir } from "@/server/workspace/paths";
import { logActivity } from "@/server/activity";

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

/** 项目稳定基口(不探测,用于重启后接管判断) */
function basePortOf(projectId: string): number {
  let hash = 0;
  for (const ch of projectId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PORT_BASE + (hash % PORT_RANGE);
}

/** 端口分配:项目稳定基口 + 占用顺延探测 */
async function allocatePort(projectId: string): Promise<number> {
  let hash = 0;
  for (const ch of projectId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  let port = PORT_BASE + (hash % PORT_RANGE);
  for (let i = 0; i < 10; i++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port);
    });
    if (free) return port;
    port = port >= PORT_BASE + PORT_RANGE ? PORT_BASE : port + 1;
  }
  return port;
}

function getOrCreate(projectId: string): RuntimeProcess {
  let rp = processes.get(projectId);
  if (!rp) {
    rp = {
      projectId,
      proc: null,
      buildProc: null,
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

/** 按端口找监听进程 PID(Windows netstat -ano) */
async function findListenerPid(port: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const marker = ":" + port + " ";
    for (const line of stdout.split("\n")) {
      if (!line.includes(marker) || !/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch {
    /* 解析失败忽略 */
  }
  return null;
}

/** Windows 下杀整棵进程树 */
async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true }).catch(
      () => {},
    );
  } else {
    await execFileAsync("kill", ["-9", String(pid)]).catch(() => {});
  }
}

function probePort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = net.connect(port, host);
    req.once("connect", () => {
      req.destroy();
      resolve(true);
    });
    req.once("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 双栈探测:vite/框架可能只绑 IPv6(::1)或 IPv4(127.0.0.1) */
async function waitForHttp(port: number, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v4 = await probePort(port, "127.0.0.1");
    if (v4) return true;
    const v6 = await probePort(port, "::1");
    if (v6) return true;
    await sleep(500);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RuntimeStatusInfo {
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

/** 依赖自愈:node_modules 缺失自动安装;dev server 二进制缺失补装 vite */
async function ensureDeps(
  rp: RuntimeProcess,
  projectDir: string,
  clientDir: string,
): Promise<void> {
  const clientNodeModules = path.join(clientDir, "node_modules");
  const pkgPath = path.join(clientDir, "package.json");
  if (!fs.existsSync(pkgPath)) return;

  if (!fs.existsSync(clientNodeModules)) {
    appendLog(rp, "system", "[runtime] 未检测到 node_modules,自动执行 npm install…");
    try {
      const { stdout } = await execFileAsync(
        "npm",
        ["install", "--no-audit", "--no-fund", "--loglevel", "error"],
        {
          cwd: clientDir,
          timeout: 600_000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          shell: process.platform === "win32",
        },
      );
      appendLog(rp, "system", `[runtime] npm install 完成\n${stdout.slice(0, 500)}`);
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      appendLog(
        rp,
        "system",
        `[runtime] npm install 失败:${clip(err.stderr || err.message || "", 800)}`,
      );
    }
  }

  // dev script 需要的本地二进制(如 vite)缺失时补装
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const devScript = pkg.scripts?.dev ?? "";
  const binName = devScript.split(/\s+/)[0];
  const binPath = path.join(
    clientNodeModules,
    ".bin",
    binName + (process.platform === "win32" ? ".cmd" : ""),
  );
  if (binName && pkg.devDependencies?.[binName] && !fs.existsSync(binPath)) {
    appendLog(rp, "system", `[runtime] 检测到 ${binName} 未安装,自动补装…`);
    try {
      await execFileAsync("npm", ["install", "-D", binName, "--loglevel", "error"], {
        cwd: clientDir,
        timeout: 600_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        shell: process.platform === "win32",
      });
      appendLog(rp, "system", `[runtime] ${binName} 安装完成`);
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      appendLog(
        rp,
        "system",
        `[runtime] ${binName} 安装失败:${clip(err.stderr || err.message || "", 800)}`,
      );
    }
  }

  // vite 配置 import 的插件(如 @vitejs/plugin-vue)缺失时全量补装,
  // 避免"node_modules 半装"状态下 dev server 起来后配置加载失败
  const configPath = ["vite.config.js", "vite.config.mjs", "vite.config.ts"]
    .map((f) => path.join(clientDir, f))
    .find((f) => fs.existsSync(f));
  if (configPath) {
    const src = fs.readFileSync(configPath, "utf8");
    const imports = [...src.matchAll(/(?:from\s*|import\s*[\s(]*)["']([^."'][^"']*)["']/g)]
      .map((m) => m[1])
      .filter((spec) => !spec.startsWith("node:"));
    const missing = [...new Set(imports)].filter((spec) => {
      const name = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      return !fs.existsSync(path.join(clientNodeModules, name, "package.json"));
    });
    if (missing.length) {
      appendLog(rp, "system", `[runtime] vite 配置依赖缺失(${missing.join(", ")}),自动补装…`);
      try {
        await execFileAsync("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], {
          cwd: clientDir,
          timeout: 600_000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          shell: process.platform === "win32",
        });
        appendLog(rp, "system", "[runtime] 依赖补装完成");
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        appendLog(
          rp,
          "system",
          `[runtime] 依赖补装失败:${clip(err.stderr || err.message || "", 800)}`,
        );
      }
    }
  }
}

/** 启动项目 dev server(真实子进程)。 */
export async function startRuntime(projectId: string, userId: string): Promise<RuntimeStatusInfo> {
  void userId; // 归属校验在路由层完成
  const rp = getOrCreate(projectId);
  if (rp.proc && (rp.status === "running" || rp.status === "starting")) {
    return getRuntimeStatus(projectId);
  }

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

  await ensureDeps(rp, projectDir, clientDir);

  // 主服务重启后内存态丢失,但旧 dev server 进程可能仍在:基口有响应则直接接管
  const basePort = basePortOf(projectId);
  if (await waitForHttp(basePort, 800)) {
    rp.port = basePort;
    rp.status = "running";
    rp.ready = true;
    appendLog(rp, "system", `[runtime] 检测到既有 dev server(端口 ${basePort}),直接接管`);
    await logActivity(projectId, "system", `接管运行中的 dev server:http://localhost:${basePort}`);
    return getRuntimeStatus(projectId);
  }

  const port = await allocatePort(projectId);
  rp.port = port;

  const proc = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: clientDir,
    env: { ...process.env, PORT: String(port), FORCE_COLOR: "0", NO_COLOR: "1", BROWSER: "none" },
    shell: true,
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
  proc.on("exit", (code) => {
    rp.exitCode = code;
    if (rp.status !== "stopped") {
      rp.status = code === 0 ? "exited" : "failed";
      appendLog(rp, "system", `[runtime] 进程退出,exit code = ${code}`);
    }
    rp.proc = null;
  });

  const ready = await waitForHttp(port, 45_000);
  if (ctrl_cancelled(rp)) {
    return getRuntimeStatus(projectId);
  }
  if (ready) {
    rp.status = "running";
    rp.ready = true;
    appendLog(rp, "system", `[runtime] 项目已启动:http://localhost:${port}`);
    await logActivity(projectId, "system", `项目启动:http://localhost:${port}`);
  } else {
    rp.status = rp.proc && rp.proc.exitCode === null ? "running" : "failed";
    appendLog(
      rp,
      "system",
      `[runtime] 端口 ${port} 在 45 秒内未就绪${rp.status === "failed" ? "(进程已退出)" : "(进程仍在运行,继续等待访问)"} `,
    );
  }
  return getRuntimeStatus(projectId);
}

function ctrl_cancelled(rp: RuntimeProcess): boolean {
  return rp.status === "stopped";
}

export async function stopRuntime(projectId: string, userId: string): Promise<RuntimeStatusInfo> {
  void userId; // 归属校验在路由层完成
  const rp = processes.get(projectId);
  if (!rp) return getRuntimeStatus(projectId);
  rp.status = "stopped";
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
  } else if (rp.port) {
    // 接管模式(无子进程句柄):按端口找监听进程并终止
    const pid = await findListenerPid(rp.port);
    if (pid) {
      appendLog(rp, "system", `[runtime] 停止项目(端口 ${rp.port},PID ${pid})`);
      await killTree(pid);
    }
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
  if (rp?.proc) {
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
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
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
