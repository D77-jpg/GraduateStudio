import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Spring Boot(Java + Maven)后端的启动支持。
 * 进程输出只保留末尾片段用于错误分类,绝不写回日志或界面;
 * 项目文件(pom.xml/.env)只读取、不修改,也不会安装依赖。
 */

const MAX_POM_BYTES = 128 * 1024;
const OUTPUT_TAIL_BYTES = 8 * 1024;
const TOOLCHAIN_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const KILL_TIMEOUT_MS = 15_000;

const TOOLCHAIN_MISSING = "本机未安装 Java 或 Maven，无法启动 Spring Boot 后端";
const FAILURE_PORT = "后端端口已被占用";
const FAILURE_DATABASE = "数据库不可达";
const FAILURE_FLYWAY = "数据库迁移失败(Flyway)";
const FAILURE_OTHER = "后端进程已退出";
const HEALTH_TIMEOUT = "Spring Boot 健康检查超时";
const HEALTH_REQUEST_FAILED = "Spring Boot 健康检查请求失败";
const HEALTH_NOT_JSON = "Spring Boot 健康检查响应不是 JSON";
const HEALTH_NOT_UP = "Spring Boot 健康检查状态不是 UP";
const HEALTH_CANCELLED = "cancelled";

export interface JavaBackendHandle {
  pid: number | null;
  stop: () => Promise<void>;
  failure: () => string | null;
}

/** 只识别 server/backend 模块里的普通 pom.xml,不跟随符号链接、不读取超大文件。 */
export function detectJavaSpringBackend(
  projectDir: string,
): { directory: string; module: "server" | "backend" } | null {
  for (const layout of ["server", "backend"] as const) {
    const directory = path.join(projectDir, layout);
    const pom = path.join(directory, "pom.xml");
    try {
      const stat = fs.lstatSync(pom);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_POM_BYTES) continue;
      const text = fs.readFileSync(pom, "utf8");
      if (text.includes("spring-boot") && text.includes("spring-boot-maven-plugin"))
        return { directory, module: layout };
    } catch {
      // Missing or unreadable manifests are simply not a Spring Boot backend.
    }
  }
  return null;
}

/** 仅探测 java/mvn 是否存在;输出全部丢弃,失败一律视为未安装。 */
export async function javaToolchain(): Promise<{ java: boolean; mvn: boolean }> {
  const probe = (command: string, args: string[]) =>
    new Promise<boolean>((resolve) => {
      try {
        execFile(
          command,
          args,
          { timeout: TOOLCHAIN_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
          (error) => resolve(!error),
        );
      } catch {
        resolve(false);
      }
    });
  const [java, mvn] = await Promise.all([
    probe("java", ["-version"]),
    // Node cannot exec a .cmd shim directly on Windows (spawn EINVAL), so probe through
    // cmd.exe exactly like the real Maven invocation does.
    process.platform === "win32"
      ? probe("cmd.exe", ["/d", "/s", "/c", "mvn -v"])
      : probe("mvn", ["-v"]),
  ]);
  return { java, mvn };
}

/**
 * Windows 无法直接 spawn .cmd shim(会 EINVAL),因此统一经 cmd.exe /d /s /c 调用;
 * POSIX 直接启动 mvn 并放入独立进程组,便于整组终止。
 */
function mavenInvocation(): { command: string; args: string[] } {
  if (process.platform === "win32")
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "mvn -B -q spring-boot:run"] };
  return { command: "mvn", args: ["-B", "-q", "spring-boot:run"] };
}

function terminateProcess(pid: number | null): Promise<void> {
  return new Promise((resolve) => {
    if (pid === null) {
      resolve();
      return;
    }
    const windows = process.platform === "win32";
    const command = windows ? "taskkill" : "kill";
    const args = windows ? ["/F", "/T", "/PID", String(pid)] : ["-9", "--", `-${pid}`];
    try {
      execFile(command, args, { timeout: KILL_TIMEOUT_MS, windowsHide: true }, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** 依据保留的输出末尾做固定分类;不回传任何原始输出。 */
function classifyFailure(tail: Buffer): string {
  const text = tail.toString("utf8");
  if (/Port .* was already in use/i.test(text) || /EADDRINUSE/.test(text)) return FAILURE_PORT;
  if (/Communications link failure/i.test(text) || /Connection refused/i.test(text))
    return FAILURE_DATABASE;
  if (/FlywayException/.test(text)) return FAILURE_FLYWAY;
  return FAILURE_OTHER;
}

export async function startJavaBackend(opts: {
  projectId: string;
  directory: string;
  port: number;
  env: Record<string, string | undefined>;
  log?: (m: string) => void;
  signal?: AbortSignal;
}): Promise<JavaBackendHandle> {
  if (opts.signal?.aborted) throw new Error("启动已取消");
  const toolchain = await javaToolchain();
  if (!toolchain.java || !toolchain.mvn) throw new Error(TOOLCHAIN_MISSING);
  if (opts.signal?.aborted) throw new Error("启动已取消");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    SERVER_PORT: String(opts.port),
  };
  // SPRING_PROFILES_ACTIVE 保持项目/宿主提供的值,这里不覆盖也不清空。
  const invocation = mavenInvocation();
  opts.log?.(`正在启动 Spring Boot 后端(项目 ${opts.projectId})…`);

  const child = spawn(invocation.command, invocation.args, {
    cwd: opts.directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const pid = child.pid ?? null;

  let tail: Buffer = Buffer.alloc(0);
  let currentFailure: string | null = null;
  let stopping = false;
  let stopPromise: Promise<void> | null = null;

  const record = (chunk: Buffer | string) => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    tail = tail.length === 0 ? buffer : Buffer.concat([tail, buffer]);
    if (tail.length > OUTPUT_TAIL_BYTES) tail = tail.subarray(tail.length - OUTPUT_TAIL_BYTES);
  };
  const recordFailure = () => {
    if (stopping) return;
    const classified = classifyFailure(tail);
    // Keep the first specific classification; only a generic exit may be refined later.
    if (!currentFailure || currentFailure === FAILURE_OTHER) currentFailure = classified;
  };

  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  child.on("exit", recordFailure);
  child.on("close", recordFailure);
  child.on("error", recordFailure);

  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopping = true;
      stopPromise = terminateProcess(pid).finally(() => {
        opts.signal?.removeEventListener("abort", onAbort);
      });
    }
    return stopPromise;
  };
  const onAbort = () => void stop();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  return { pid, stop, failure: () => currentFailure };
}

function isSpringUp(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { status?: unknown }).status === "UP"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询 Spring Boot Actuator 健康端点;只接受 JSON 且 status === "UP"。
 * 不跟随重定向,单次请求不超过 2s,错误文案固定且不包含响应内容。
 */
export async function waitForSpringHealth(
  baseUrl: string,
  opts: { timeoutMs?: number; cancelled?: () => boolean; signal?: AbortSignal } = {},
): Promise<{ ready: boolean; error: string | null }> {
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const cancelled = opts.cancelled ?? (() => false);
  const isCancelled = () => Boolean(opts.signal?.aborted) || cancelled();
  const url = `${baseUrl.replace(/\/+$/, "")}/actuator/health`;
  let lastError = HEALTH_TIMEOUT;

  for (;;) {
    if (isCancelled()) return { ready: false, error: HEALTH_CANCELLED };
    try {
      const controller = new AbortController();
      const budget = Math.max(1, Math.min(HEALTH_REQUEST_TIMEOUT_MS, deadline - Date.now()));
      const timer = setTimeout(() => controller.abort(), budget);
      const abort = () => controller.abort();
      opts.signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetch(url, { signal: controller.signal, redirect: "error" });
        if (!response.ok) {
          await response.body?.cancel();
          lastError = `Spring Boot 健康检查返回 HTTP ${response.status}`;
        } else {
          const body = await response.text();
          let parsed: unknown;
          let parsedOk = true;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsedOk = false;
          }
          if (!parsedOk) lastError = HEALTH_NOT_JSON;
          else if (isSpringUp(parsed)) {
            if (isCancelled()) return { ready: false, error: HEALTH_CANCELLED };
            return { ready: true, error: null };
          } else lastError = HEALTH_NOT_UP;
        }
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
      }
    } catch {
      if (isCancelled()) return { ready: false, error: HEALTH_CANCELLED };
      lastError = HEALTH_REQUEST_FAILED;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.max(0, Math.min(HEALTH_POLL_INTERVAL_MS, deadline - Date.now())));
  }
  // An unreachable endpoint timed out; a responding-but-wrong endpoint keeps its fixed reason.
  return {
    ready: false,
    error: lastError === HEALTH_REQUEST_FAILED ? HEALTH_TIMEOUT : lastError,
  };
}
