import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { inventoryWorkspace } from "./codex-assets";
import { scanStackMarkers, unsupportedMarkers, type StackMarker } from "./stack-profiles";
import {
  CONTRACT_PATH,
  findComposeFile,
  loadDeliveryContract,
  missingRoles,
  type DeliveryContract,
  type SmokeSpec,
} from "./delivery-contract";

/**
 * 交付闸门（Delivery Gate）
 *
 * passed 的定义：本次应当出现的每一项检查都实际执行并通过。任何“应当出现但没出现”的
 * 检查都会以 blocked 记入报告——这是与旧版 codex-acceptance 的根本区别（旧版是“出现的检查
 * 里没有失败即 passed”，于是没有检查器的后端直接从报告里消失）。
 *
 * fast 层：在官方工具链镜像里对“干净副本”从零安装依赖、构建、跑测试（Node / Maven / Python）。
 * full 层：在 fast 之上，用生成项目自己的 compose 启动整套系统，按交付契约做健康检查、
 *         HTTP 冒烟（含写入后回读）、重启后持久化复查、浏览器页面检查并截图。
 *
 * 所有命令都在容器里执行，宿主机只运行 docker 客户端；检查对象是 stage 的临时副本，
 * 闸门不会修改 stage（构建产物 target/、dist/ 不会混进变更集）。
 */

export type GateStatus = "passed" | "failed" | "blocked";
export type GateTier = "fast" | "full" | "auto";
export type CheckCause = "code" | "environment";

export interface GateCheck {
  name: string;
  label?: string;
  status: "passed" | "failed" | "blocked" | "not_run";
  /** code：模型改代码可以解决（会触发修复）；environment：Docker/网络/不支持的栈（暂停，不花模型钱）。 */
  cause?: CheckCause;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  output: string;
}

export interface DeliveryGateResult {
  version: 1;
  status: GateStatus;
  tier: "fast" | "full";
  checks: GateCheck[];
  screenshots: string[];
  startedAt: string;
  finishedAt: string;
}

export interface SmokeScopeEntry {
  moduleId: string;
  smoke: SmokeSpec[];
}

export interface DeliveryGateOptions {
  signal?: AbortSignal;
  tier?: GateTier;
  /** 业务模块的冒烟（来自冻结的计划）；契约里的骨架冒烟总是会执行。 */
  smoke?: SmokeScopeEntry[];
  /** 截图等产物的保留目录（建议在 stage 之外的任务状态目录）。 */
  artifactsDir?: string;
  label?: string;
  /** 测试注入点。 */
  docker?: DockerRunner;
}

export interface DockerOutcome {
  code: number | null;
  output: string;
  timedOut: boolean;
  spawnError: boolean;
}
export type DockerRunner = (
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; cwd?: string },
) => Promise<DockerOutcome>;

const OUTPUT_TAIL = 48 * 1024;
const CHECK_OUTPUT_LIMIT = 12 * 1024;
const CACHE_VOLUME = process.env.GS_GATE_CACHE_VOLUME?.trim() || "gs-gate-cache";
const NETWORK = process.env.GS_GATE_NETWORK?.trim() || "bridge";
const IMAGES = {
  node: process.env.GS_GATE_NODE_IMAGE?.trim() || "node:22-bookworm",
  maven: process.env.GS_GATE_MAVEN_IMAGE?.trim() || "maven:3.9-eclipse-temurin-17",
  python: process.env.GS_GATE_PYTHON_IMAGE?.trim() || "python:3.12-slim",
  probe: process.env.GS_GATE_PROBE_IMAGE?.trim() || "node:22-bookworm-slim",
  playwright:
    process.env.GS_GATE_PLAYWRIGHT_IMAGE?.trim() || "mcr.microsoft.com/playwright:v1.49.1-noble",
};
const BUILD_TIMEOUT_MS = Number(process.env.GS_GATE_BUILD_TIMEOUT_MS) || 15 * 60_000;
const UP_TIMEOUT_MS = Number(process.env.GS_GATE_UP_TIMEOUT_MS) || 25 * 60_000;
const RUNNER_DIR = path.resolve(process.cwd(), "resources/delivery-gate");
/**
 * 闸门自己的容器一律禁止提权。Playwright 容器例外：Chromium 的 setuid 沙箱在
 * no-new-privileges 下无法启动，会让页面检查全部误判失败。
 */
const NO_NEW_PRIVILEGES = ["--security-opt", "no-new-privileges:true"];

/* ------------------------------------------------------------------ */
/* 纯函数：状态判定、证据格式化（单元测试覆盖）                           */
/* ------------------------------------------------------------------ */

/** 缺失即 blocked：expected 中没有出现的检查补记为 blocked。 */
export function finalizeChecks(checks: GateCheck[], expected: string[]): GateCheck[] {
  const present = new Set(checks.map((c) => c.name));
  // 若已有代码类失败，缺失项多半是它的连带后果（例如后端没起来，冒烟自然没跑），归为 code，
  // 这样修复回路仍会启动；否则视为执行环境问题，暂停而不消耗模型调用。
  const consequence = checks.some((c) => c.status === "failed" && c.cause !== "environment");
  const result = [...checks];
  for (const name of expected)
    if (!present.has(name))
      result.push({
        name,
        status: "blocked",
        cause: consequence ? "code" : "environment",
        output: consequence
          ? "前置检查失败，该检查未能执行；修复上面的失败项后会重新验证。"
          : "该检查本应执行但没有产生结果（被取消或执行器异常）。缺少证据不等于通过。",
      });
  return result;
}

export function decideGateStatus(checks: GateCheck[]): GateStatus {
  if (checks.some((c) => c.status === "failed")) return "failed";
  if (!checks.length || checks.some((c) => c.status !== "passed")) return "blocked";
  return "passed";
}

/** 是否值得调用模型修复：存在未通过检查，且没有任何环境类阻塞。 */
export function gateNeedsRepair(result: { checks: Array<Pick<GateCheck, "status" | "cause">> }) {
  const bad = result.checks.filter((c) => c.status !== "passed");
  if (!bad.length) return false;
  return !bad.some((c) => c.cause === "environment");
}

export function gateEnvironmentProblems(result: { checks: GateCheck[] }): GateCheck[] {
  return result.checks.filter((c) => c.status !== "passed" && c.cause === "environment");
}

const ENV_PATTERNS =
  /Cannot connect to the Docker daemon|docker daemon is not running|error during connect|pull access denied|manifest unknown|TLS handshake timeout|Temporary failure in name resolution|EAI_AGAIN|ENOTFOUND registry|getaddrinfo|ECONNRESET|ETIMEDOUT|Could not transfer artifact|UnknownHostException|Connection timed out|network is unreachable|no space left on device|toomanyrequests/i;

export function classifyCause(output: string, fallback: CheckCause = "code"): CheckCause {
  return ENV_PATTERNS.test(output) ? "environment" : fallback;
}

/** 只隐藏宿主环境里真实存在的密钥值；不做会误伤诊断信息的模式匹配，也不截成 3000 字。 */
export function redactKnownSecrets(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  let result = text;
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (!/(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(key)) continue;
    result = result.split(value).join(`[已隐藏:${key}]`);
  }
  return result;
}

function tail(text: string, limit = CHECK_OUTPUT_LIMIT): string {
  return text.length > limit ? "…(前略)\n" + text.slice(text.length - limit) : text;
}

/** 给修复轮模型的证据：只含未通过检查，每项保留输出尾部（错误通常在末尾）。 */
export function formatGateEvidence(result: DeliveryGateResult, limit = 40_000): string {
  const parts: string[] = [`交付闸门（${result.tier}）结果：${result.status}`];
  for (const check of result.checks.filter((c) => c.status !== "passed")) {
    parts.push(
      [
        `### ${check.name}${check.label ? `（${check.label}）` : ""} → ${check.status}`,
        check.command ? `命令：${check.command}` : "",
        typeof check.exitCode === "number" ? `退出码：${check.exitCode}` : "",
        tail(check.output, 6000),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const text = parts.join("\n\n");
  return text.length > limit ? text.slice(0, limit) + "\n…(证据过长已截断)" : text;
}

export function gateFingerprint(result: DeliveryGateResult): string {
  const failing = result.checks
    .filter((c) => c.status !== "passed")
    .map((c) => `${c.name}:${c.status}:${c.output.slice(-800)}`);
  return createHash("sha256").update(JSON.stringify(failing)).digest("hex");
}

/** 拆分容器脚本中 `GS_STEP <name> <exit>` 标记，得到每个步骤的输出与退出码。 */
export function parseSteps(output: string): Map<string, { code: number; output: string }> {
  const steps = new Map<string, { code: number; output: string }>();
  let buffer = "";
  for (const line of output.split(/\r?\n/)) {
    const match = /^GS_STEP ([a-z-]+) (\d+)$/.exec(line.trim());
    if (match) {
      steps.set(match[1], { code: Number(match[2]), output: buffer });
      buffer = "";
    } else buffer += line + "\n";
  }
  return steps;
}

/** Maven 汇总行（不含 " - in 类名" 的那一行）。 */
export function mavenTestSummary(
  output: string,
): { run: number; failed: number; skipped: number } | null {
  let last: { run: number; failed: number; skipped: number } | null = null;
  for (const line of output.split(/\r?\n/)) {
    const m =
      /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)(.*)$/.exec(
        line,
      );
    if (m && !/ - in /.test(m[5]))
      last = { run: Number(m[1]), failed: Number(m[2]) + Number(m[3]), skipped: Number(m[4]) };
  }
  return last;
}

export function nodeTestEvidence(output: string): boolean {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  if (/no test(?:s| files| suites)?(?: were)? found|no tests? (?:to run|executed)/i.test(text))
    return false;
  return /\b[1-9]\d*\s+(?:passed|passing)\b|Tests:\s+[1-9]\d*\s+passed|(?:^|\n)\s*(?:#\s*)?pass\s+[1-9]\d*\b|(?:^|\n)\s*ok\s+[1-9]\d*\b/i.test(
    text,
  );
}

/** 运行时层应当出现的检查清单，事先算出，用于“缺失即 blocked”。 */
export function expectedRuntimeChecks(
  contract: DeliveryContract,
  scope: SmokeScopeEntry[],
): string[] {
  const names = ["runtime:compose-up", "runtime:health:backend"];
  if (contract.frontend) names.push("runtime:health:frontend");
  let persistence = false;
  for (const { moduleId, smoke } of scope)
    smoke.forEach((step, index) => {
      if (step.kind === "http") {
        names.push(`smoke:${moduleId}:${index}`);
        const refs = [
          ...JSON.stringify([step.path, step.body ?? null]).matchAll(/\{\{([A-Za-z_]\w*)\}\}/g),
        ];
        if (step.method === "GET" && refs.some((m) => m[1] !== "rand")) {
          names.push(`persist:${moduleId}:${index}`);
          persistence = true;
        }
      } else if (contract.frontend) names.push(`page:${moduleId}:${index}`);
    });
  if (persistence) names.push("persist:restart", "persist:health");
  return names;
}

export function composeOverride(services: string[]): string {
  // 去掉所有宿主端口映射：闸门实例与用户正在运行的预览互不抢端口；探针走 compose 内部网络。
  // `!reset` 需要 Docker Compose ≥ 2.24.4。
  // no-new-privileges 阻止容器内提权。这里刻意不加 cap_drop:[ALL]——官方数据库镜像
  // （postgres/mysql）需要 CHOWN/SETUID/SETGID/DAC_OVERRIDE 才能启动，全丢会让闸门误判为代码问题。
  return (
    [
      "services:",
      ...services.flatMap((s) => [
        `  ${JSON.stringify(s)}:`,
        "    ports: !reset []",
        "    security_opt:",
        "      - no-new-privileges:true",
      ]),
    ].join("\n") + "\n"
  );
}

/* ------------------------------------------------------------------ */
/* compose 安全审计                                                     */
/* ------------------------------------------------------------------ */

/** 宿主敏感路径：bind mount 或 named-volume device 指到这里等于把宿主机交出去。 */
const HOST_PATH_DENYLIST =
  /(docker\.sock|^\/(?:var\/run|run|etc|proc|sys|dev|boot|root|home|usr|var\/lib\/docker)(?:\/|$))/i;
/** 这些键的值是宿主路径，必须落在工作区副本内。 */
const HOST_PATH_KEYS = new Set(["source", "device", "context", "file", "path"]);
/** 出现即拒绝，不看值：没有正当理由让生成的项目需要它们。 */
const FORBIDDEN_PRESENCE = new Map([
  ["cap_add", "cap_add（额外内核能力）"],
  ["devices", "devices（宿主设备直通）"],
  ["cgroup_parent", "cgroup_parent（可影响宿主 cgroup 层级）"],
  ["userns_mode", "userns_mode（宿主用户命名空间）"],
]);
/** 值必须是特定内容才拒绝。 */
const FORBIDDEN_VALUES = new Map([
  ["privileged", "privileged: true（容器等于宿主 root）"],
  ["network_mode", "network_mode: host（共享宿主网络栈）"],
  ["pid", "pid: host（可见并干预宿主进程）"],
  ["ipc", "ipc: host（共享宿主 IPC）"],
]);
const FORBIDDEN_SECURITY_OPT =
  /(seccomp=unconfined|apparmor=unconfined|label:disable|systempaths=unconfined)/i;

function asHostPathProblem(value: string, root: string): string | null {
  if (!value) return null;
  // 具名卷（source: dbdata）与相对路径不是宿主路径：相对路径由 compose 按 --project-directory 解析。
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) return null;
  if (HOST_PATH_DENYLIST.test(value)) return `挂载了宿主敏感路径：${value}`;
  const base = root.replace(/\/+$/, "");
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  // 等值也要放行：build.context 常常就是副本根目录本身。
  if (normalized !== base && !normalized.startsWith(base + "/"))
    return `挂载了工作区副本之外的宿主路径：${value}`;
  return null;
}

/**
 * compose.yaml 是模型生成的，`up --build` 之前必须审计：任何能触达宿主机的配置一律拒绝。
 * 同时审计原始文件与 `docker compose config` 的规范化输出——后者会展开锚点/合并键并把
 * 相对路径解析成绝对路径，前者是输出被截断时的兜底。
 */
export function auditComposeConfig(config: string, copyRoot: string): string[] {
  const root = path.resolve(copyRoot).replace(/\\/g, "/").toLowerCase().replace(/\/?$/, "/");
  const problems: string[] = [];
  const seen = new Set<string>();
  const add = (problem: string | null) => {
    if (problem && !seen.has(problem)) {
      seen.add(problem);
      problems.push(problem);
    }
  };
  let listKey = "";
  for (const line of config.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    if (text.startsWith("- ") || text === "-") {
      const item = text
        .slice(1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (listKey === "security_opt" && FORBIDDEN_SECURITY_OPT.test(item))
        add(`security_opt 关闭了容器隔离：${item}`);
      // 原始文件里的短写挂载（"宿主路径:容器路径"）。
      if (listKey === "volumes" && item.includes(":"))
        add(asHostPathProblem(item.split(":")[0].trim(), root));
      continue;
    }
    const entry = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(text);
    if (!entry) continue;
    const key = entry[1].toLowerCase();
    const scalar = entry[2].trim().replace(/^["']|["']$/g, "");
    listKey = scalar ? "" : key;
    if (FORBIDDEN_PRESENCE.has(key)) add(FORBIDDEN_PRESENCE.get(key)!);
    if (key === "security_opt" && FORBIDDEN_SECURITY_OPT.test(scalar))
      add(`security_opt 关闭了容器隔离：${scalar}`);
    const forbidden = FORBIDDEN_VALUES.get(key);
    if (forbidden && (scalar === "true" || scalar === "host")) add(forbidden);
    if (HOST_PATH_KEYS.has(key)) add(asHostPathProblem(scalar, root));
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* Docker 执行                                                          */
/* ------------------------------------------------------------------ */

export const defaultDocker: DockerRunner = (args, { timeoutMs, signal, cwd }) =>
  new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let spawnError = false;
    let settled = false;
    const decoder = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
    const append = (text: string) => {
      output += text;
      if (output.length > OUTPUT_TAIL * 2) output = output.slice(output.length - OUTPUT_TAIL);
    };
    const child = spawn("docker", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DOCKER_CLI_HINTS: "false" },
    });
    child.stdout.on("data", (chunk: Buffer) => append(decoder.out.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => append(decoder.err.write(chunk)));
    const stop = () => {
      timedOut = !signal?.aborted;
      child.kill();
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      append(decoder.out.end() + decoder.err.end());
      resolve({
        code,
        output: redactKnownSecrets(tail(output, OUTPUT_TAIL)),
        timedOut,
        spawnError,
      });
    };
    child.once("error", () => {
      spawnError = true;
      finish(null);
    });
    child.once("close", finish);
  });

function hostUserArgs(): string[] {
  // Linux 宿主上以宿主用户运行，容器写出的文件宿主可以删除；Docker Desktop 自行映射权限。
  if (
    process.platform === "linux" &&
    typeof process.getuid === "function" &&
    typeof process.getgid === "function"
  )
    return ["--user", `${process.getuid()}:${process.getgid()}`];
  return [];
}

function cacheEnvArgs(): string[] {
  const args = [
    "--env",
    "HOME=/tmp/home",
    "--env",
    "CI=true",
    "--env",
    "npm_config_cache=/cache/npm",
    "--env",
    "npm_config_update_notifier=false",
    "--env",
    "PIP_CACHE_DIR=/cache/pip",
    "--env",
    "PIP_DISABLE_PIP_VERSION_CHECK=1",
    "--env",
    "MAVEN_CONFIG=",
  ];
  if (process.env.GS_GATE_NPM_REGISTRY)
    args.push("--env", `npm_config_registry=${process.env.GS_GATE_NPM_REGISTRY}`);
  if (process.env.GS_GATE_PIP_INDEX)
    args.push("--env", `PIP_INDEX_URL=${process.env.GS_GATE_PIP_INDEX}`);
  return args;
}

export const GATE_CACHE_VOLUME = CACHE_VOLUME;

async function ensureCacheVolume(
  docker: DockerRunner,
  signal?: AbortSignal,
): Promise<string | null> {
  const inspected = await docker(["volume", "inspect", CACHE_VOLUME], {
    timeoutMs: 30_000,
    signal,
  });
  if (inspected.spawnError) return "无法执行 docker：请确认 Docker 已安装并正在运行。";
  if (inspected.code !== 0) {
    const created = await docker(["volume", "create", CACHE_VOLUME], { timeoutMs: 30_000, signal });
    if (created.code !== 0) return created.output || "无法创建依赖缓存卷";
  }
  // 每次只修正顶层目录权限（便宜）：闸门容器（宿主 uid）与 Codex worker（uid 10001）共用缓存，
  // 两边都以 umask 0000 写入，子目录天然可共享。
  const init = await docker(
    [
      "run",
      "--rm",
      ...NO_NEW_PRIVILEGES,
      "-v",
      `${CACHE_VOLUME}:/cache`,
      IMAGES.probe,
      "sh",
      "-c",
      "mkdir -p /cache/m2 /cache/npm /cache/pip && chmod 0777 /cache /cache/m2 /cache/npm /cache/pip",
    ],
    { timeoutMs: 10 * 60_000, signal },
  );
  return init.code === 0 ? null : init.output || "无法初始化依赖缓存卷";
}

/** 供编排层在创建挂载缓存卷的 worker 之前调用；失败不抛出（交付闸门会如实报告环境问题）。 */
export async function ensureGateCacheVolume(signal?: AbortSignal): Promise<string | null> {
  try {
    return await ensureCacheVolume(defaultDocker, signal);
  } catch (error) {
    return String(error);
  }
}

async function runInImage(
  docker: DockerRunner,
  input: { image: string; mount: string; script: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<DockerOutcome & { durationMs: number }> {
  const started = Date.now();
  const outcome = await docker(
    [
      "run",
      "--rm",
      "--name",
      `gs-gate-${randomUUID()}`,
      ...hostUserArgs(),
      "--network",
      NETWORK,
      "--cpus",
      "2",
      "--memory",
      "3g",
      "--pids-limit",
      "1024",
      // 不加 --cap-drop ALL：Windows 宿主上容器以 root 运行，丢掉 CAP_CHOWN 会让共享
      // 缓存卷（跨平台写入、属主不一致）无法修复而构建失败。
      ...NO_NEW_PRIVILEGES,
      "--tmpfs",
      "/tmp:rw,exec,size=1g,mode=1777",
      ...cacheEnvArgs(),
      "-v",
      `${CACHE_VOLUME}:/cache`,
      "-v",
      `${input.mount}:/w`,
      "-w",
      "/w",
      "--entrypoint",
      "sh",
      input.image,
      "-c",
      `umask 0000; mkdir -p /tmp/home; ${input.script}`,
    ],
    { timeoutMs: input.timeoutMs ?? BUILD_TIMEOUT_MS, signal: input.signal },
  );
  return { ...outcome, durationMs: Date.now() - started };
}

/* ------------------------------------------------------------------ */
/* fast 层：按栈构建 + 测试                                              */
/* ------------------------------------------------------------------ */

async function readScripts(file: string): Promise<Record<string, string>> {
  try {
    const manifest = JSON.parse(await fs.readFile(file, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return Object.fromEntries(
      Object.entries(manifest.scripts ?? {}).filter(
        (e): e is [string, string] => typeof e[1] === "string" && !!e[1].trim(),
      ),
    );
  } catch {
    return {};
  }
}

function infraFailure(name: string, outcome: DockerOutcome, command: string): GateCheck | null {
  if (outcome.spawnError)
    return {
      name,
      status: "blocked",
      cause: "environment",
      command,
      output: "无法启动 docker 客户端；请确认 Docker 已安装并运行。",
    };
  if (outcome.timedOut)
    return {
      name,
      status: "failed",
      cause: classifyCause(outcome.output),
      command,
      output: `执行超时。\n${tail(outcome.output)}`,
    };
  if (outcome.code === 125)
    return {
      name,
      status: "blocked",
      cause: "environment",
      command,
      output: `容器无法创建（镜像拉取或 Docker 配置问题）。\n${tail(outcome.output)}`,
    };
  return null;
}

async function nodeChecks(
  docker: DockerRunner,
  copy: string,
  marker: StackMarker,
  signal?: AbortSignal,
) {
  const root = marker.root || ".";
  const scripts = await readScripts(path.join(copy, marker.root, "package.json"));
  const checks: GateCheck[] = [];
  const wanted = (["build", "test"] as const).filter((s) => scripts[s]);
  for (const s of ["build", "test"] as const)
    if (!scripts[s])
      checks.push({
        name: `${root}:${s}`,
        status: "blocked",
        cause: "code",
        output: `${root}/package.json 没有声明 ${s} 脚本。交付项目必须可构建且有可执行测试。`,
      });
  if (!wanted.length) return checks;
  const script = [
    "set +e",
    "if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi",
    'echo "GS_STEP install $?"',
    ...wanted.flatMap((s) => [`npm run ${s}`, `echo "GS_STEP ${s} $?"`]),
  ].join("\n");
  const command = `npm ci|install && ${wanted.map((s) => `npm run ${s}`).join(" && ")}（${IMAGES.node}）`;
  const outcome = await runInImage(docker, {
    image: IMAGES.node,
    mount: path.join(copy, marker.root),
    script,
    signal,
  });
  const infra = infraFailure(`${root}:install`, outcome, command);
  if (infra) return [...checks, infra];
  const steps = parseSteps(outcome.output);
  const install = steps.get("install");
  if (!install || install.code !== 0) {
    checks.push({
      name: `${root}:install`,
      status: "failed",
      cause: classifyCause(install?.output ?? outcome.output),
      command: "npm ci / npm install",
      exitCode: install?.code,
      durationMs: outcome.durationMs,
      output: tail(install?.output ?? outcome.output),
    });
    return checks;
  }
  for (const s of wanted) {
    const step = steps.get(s);
    const name = `${root}:${s}`;
    if (!step) {
      checks.push({
        name,
        status: "blocked",
        cause: "environment",
        command: `npm run ${s}`,
        output: tail(outcome.output),
      });
      continue;
    }
    const evidence = s === "test" ? nodeTestEvidence(step.output) : true;
    checks.push({
      name,
      status: step.code !== 0 ? "failed" : evidence ? "passed" : "blocked",
      cause: step.code !== 0 ? classifyCause(step.output) : evidence ? undefined : "code",
      command: `npm run ${s}`,
      exitCode: step.code,
      durationMs: outcome.durationMs,
      output:
        (step.code === 0 && !evidence
          ? "退出码为 0，但没有找到“N passed”之类的已执行测试证据。\n"
          : "") + tail(step.output),
    });
  }
  return checks;
}

function mavenSettingsScript(): string {
  const mirror = process.env.GS_GATE_MAVEN_MIRROR?.trim();
  if (!mirror) return "";
  const xml = `<settings><mirrors><mirror><id>gs</id><mirrorOf>central</mirrorOf><url>${mirror}</url></mirror></mirrors></settings>`;
  return `mkdir -p /tmp/home/.m2 && printf '%s' '${xml.replace(/'/g, "")}' > /tmp/home/.m2/settings.xml; `;
}

async function mavenCheck(
  docker: DockerRunner,
  copy: string,
  marker: StackMarker,
  signal?: AbortSignal,
): Promise<GateCheck> {
  const root = marker.root || ".";
  const name = `${root}:maven:test`;
  const command = `mvn -B test（${IMAGES.maven}）`;
  const outcome = await runInImage(docker, {
    image: IMAGES.maven,
    mount: path.join(copy, marker.root),
    signal,
    script: `${mavenSettingsScript()}mvn -B -ntp -Dstyle.color=never -Duser.home=/tmp/home -Dmaven.repo.local=/cache/m2${process.env.GS_GATE_MAVEN_MIRROR?.trim() ? " -s /tmp/home/.m2/settings.xml" : ""} test; echo "GS_STEP maven $?"`,
  });
  const infra = infraFailure(name, outcome, command);
  if (infra) return infra;
  const step = parseSteps(outcome.output).get("maven");
  if (!step)
    return { name, status: "blocked", cause: "environment", command, output: tail(outcome.output) };
  const summary = mavenTestSummary(step.output);
  if (step.code !== 0)
    return {
      name,
      status: "failed",
      cause: classifyCause(step.output),
      command,
      exitCode: step.code,
      durationMs: outcome.durationMs,
      output: tail(step.output),
    };
  if (!summary || summary.run - summary.skipped <= 0)
    return {
      name,
      status: "blocked",
      cause: "code",
      command,
      exitCode: 0,
      durationMs: outcome.durationMs,
      output: `编译通过，但没有执行任何测试（交付项目需要至少一个真实执行的后端测试）。\n${tail(step.output, 4000)}`,
    };
  return {
    name,
    status: "passed",
    command,
    exitCode: 0,
    durationMs: outcome.durationMs,
    output: `Tests run: ${summary.run}, Failures/Errors: ${summary.failed}, Skipped: ${summary.skipped}\n${tail(step.output, 2000)}`,
  };
}

async function pythonCheck(
  docker: DockerRunner,
  copy: string,
  marker: StackMarker,
  signal?: AbortSignal,
): Promise<GateCheck> {
  const root = marker.root || ".";
  const name = `${root}:python:test`;
  const command = `pip install && compileall && pytest（${IMAGES.python}）`;
  const script = [
    "set +e",
    "python -m venv /tmp/venv && . /tmp/venv/bin/activate",
    'if [ -f requirements.txt ]; then pip install -q -r requirements.txt; elif [ -f pyproject.toml ]; then pip install -q -e ".[test]" || pip install -q -e .; fi',
    'echo "GS_STEP install $?"',
    "[ -f requirements-dev.txt ] && pip install -q -r requirements-dev.txt",
    "python -c 'import pytest' 2>/dev/null || pip install -q pytest",
    "python -m compileall -q -x '(venv|\\.venv|node_modules)' .",
    'echo "GS_STEP compile $?"',
    "python -m pytest -q",
    'echo "GS_STEP test $?"',
  ].join("\n");
  const outcome = await runInImage(docker, {
    image: IMAGES.python,
    mount: path.join(copy, marker.root),
    script,
    signal,
  });
  const infra = infraFailure(name, outcome, command);
  if (infra) return infra;
  const steps = parseSteps(outcome.output);
  for (const stepName of ["install", "compile"]) {
    const step = steps.get(stepName);
    if (!step || step.code !== 0)
      return {
        name,
        status: "failed",
        cause: classifyCause(step?.output ?? outcome.output),
        command,
        exitCode: step?.code,
        durationMs: outcome.durationMs,
        output: `${stepName} 失败。\n${tail(step?.output ?? outcome.output)}`,
      };
  }
  const test = steps.get("test");
  if (!test)
    return { name, status: "blocked", cause: "environment", command, output: tail(outcome.output) };
  if (test.code === 5 || !/\b[1-9]\d*\s+passed\b/.test(test.output))
    return {
      name,
      status: test.code === 0 || test.code === 5 ? "blocked" : "failed",
      cause: "code",
      command,
      exitCode: test.code,
      durationMs: outcome.durationMs,
      output: (test.code === 5 ? "pytest 没有收集到任何测试。\n" : "") + tail(test.output),
    };
  return {
    name,
    status: "passed",
    command,
    exitCode: 0,
    durationMs: outcome.durationMs,
    output: tail(test.output, 2000),
  };
}

/* ------------------------------------------------------------------ */
/* full 层：compose + 冒烟 + 持久化 + 页面                               */
/* ------------------------------------------------------------------ */

interface RunnerResult {
  id: string;
  ok: boolean;
  label?: string;
  detail?: string;
  screenshot?: string;
}
export function parseRunnerResults(output: string): RunnerResult[] {
  const results: RunnerResult[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("GS_RESULT ")) continue;
    try {
      const parsed = JSON.parse(line.slice("GS_RESULT ".length)) as RunnerResult;
      if (typeof parsed.id === "string" && typeof parsed.ok === "boolean") results.push(parsed);
    } catch {
      /* ignore malformed line */
    }
  }
  return results;
}

function toChecks(results: RunnerResult[]): GateCheck[] {
  return results.map((r) => ({
    name: r.id,
    label: r.label,
    status: r.ok ? "passed" : "failed",
    cause: r.ok ? undefined : "code",
    output: r.detail ?? "",
  }));
}

async function runtimeChecks(input: {
  docker: DockerRunner;
  copy: string;
  composeFile: string;
  contract: DeliveryContract;
  scope: SmokeScopeEntry[];
  signal?: AbortSignal;
  artifactsDir?: string;
}): Promise<{ checks: GateCheck[]; screenshots: string[] }> {
  const { docker, copy, composeFile, contract, scope, signal } = input;
  const checks: GateCheck[] = [];
  const screenshots: string[] = [];
  const project = `gs-gate-${createHash("sha256").update(copy).digest("hex").slice(0, 10)}`;
  const base = [
    "compose",
    "-p",
    project,
    "--project-directory",
    copy,
    "-f",
    path.join(copy, composeFile),
  ];
  const listed = await docker([...base, "config", "--services"], {
    timeoutMs: 60_000,
    signal,
    cwd: copy,
  });
  if (listed.code !== 0) {
    checks.push({
      name: "runtime:compose-up",
      status: "failed",
      cause: classifyCause(listed.output),
      command: "docker compose config",
      exitCode: listed.code ?? undefined,
      output: `compose 文件无效。\n${tail(listed.output)}`,
    });
    return { checks, screenshots };
  }
  const services = listed.output.split(/\s+/).filter((s) => /^[a-zA-Z0-9_.-]+$/.test(s));
  // 审计发生在 up 之前：compose 由模型生成，一旦带 docker.sock / privileged / 宿主绝对路径挂载，
  // `up --build` 就等于把宿主机交给生成物。这里拒绝时不启动任何容器。
  const resolved = await docker([...base, "config"], { timeoutMs: 60_000, signal, cwd: copy });
  const rawCompose = await fs.readFile(path.join(copy, composeFile), "utf8").catch(() => "");
  const violations = [
    ...new Set([
      ...auditComposeConfig(resolved.output, copy),
      ...auditComposeConfig(rawCompose, copy),
    ]),
  ];
  if (resolved.code !== 0 || violations.length) {
    checks.push({
      name: "runtime:compose-up",
      status: "failed",
      cause: violations.length ? "code" : classifyCause(resolved.output),
      command: "docker compose config",
      exitCode: resolved.code ?? undefined,
      output: violations.length
        ? [
            "compose 配置被闸门拒绝，未启动任何容器：",
            ...violations.map((v) => `- ${v}`),
            "",
            "规则：只允许挂载工作区副本内的路径；不得使用 privileged / cap_add / devices / host 网络或 PID 命名空间 / 关闭 seccomp。",
            "这条失败属于代码问题，修复 compose.yaml 后重跑即可。",
          ].join("\n")
        : `compose 文件无效。\n${tail(resolved.output)}`,
    });
    return { checks, screenshots };
  }
  const files = [...base];
  if (process.env.GS_GATE_KEEP_PORTS !== "1") {
    const override = path.join(copy, ".gs-gate-override.yaml");
    await fs.writeFile(override, composeOverride(services), "utf8");
    files.push("-f", override);
  }
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "gs-gate-out-"));
  const specDir = path.join(copy, ".gs-gate-spec");
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(path.join(specDir, "contract.json"), JSON.stringify(contract), "utf8");
  await fs.writeFile(path.join(specDir, "smoke.json"), JSON.stringify(scope), "utf8");
  await fs.chmod(outDir, 0o777).catch(() => {});
  const network = `${project}_${contract.network ?? "default"}`;
  const diagnostics = async () => {
    const ps = await docker([...files, "ps", "-a"], { timeoutMs: 60_000, signal, cwd: copy });
    const logs = await docker([...files, "logs", "--no-color", "--tail", "150"], {
      timeoutMs: 60_000,
      signal,
      cwd: copy,
    });
    return `\n--- docker compose ps -a ---\n${tail(ps.output, 3000)}\n--- docker compose logs --tail 150 ---\n${tail(logs.output, 9000)}`;
  };
  const probe = async (mode: "run" | "recheck") =>
    docker(
      [
        "run",
        "--rm",
        ...hostUserArgs(),
        ...NO_NEW_PRIVILEGES,
        "--network",
        network,
        "--env",
        `GS_MODE=${mode}`,
        "-v",
        `${RUNNER_DIR}:/runner:ro`,
        "-v",
        `${specDir}:/spec:ro`,
        "-v",
        `${outDir}:/out`,
        IMAGES.probe,
        "node",
        "/runner/smoke-runner.mjs",
      ],
      { timeoutMs: 8 * 60_000, signal },
    );
  try {
    const started = Date.now();
    const up = await docker([...files, "up", "-d", "--build", "--wait", "--wait-timeout", "420"], {
      timeoutMs: UP_TIMEOUT_MS,
      signal,
      cwd: copy,
    });
    if (up.code !== 0) {
      checks.push({
        name: "runtime:compose-up",
        status: "failed",
        cause: classifyCause(up.output),
        command: "docker compose up -d --build --wait",
        exitCode: up.code ?? undefined,
        durationMs: Date.now() - started,
        output: tail(up.output, 6000) + (await diagnostics()),
      });
      return { checks, screenshots };
    }
    checks.push({
      name: "runtime:compose-up",
      status: "passed",
      command: "docker compose up -d --build --wait",
      durationMs: Date.now() - started,
      output: `服务：${services.join("、")}`,
    });
    const first = await probe("run");
    const results = parseRunnerResults(first.output);
    if (contract.frontend) results.push(await frontendHealth(docker, network, contract, signal));
    checks.push(...toChecks(results));
    if (!results.length)
      checks.push({
        name: "runtime:probe",
        status: "blocked",
        cause: "environment",
        output: tail(first.output),
      });
    const failedRuntime = results.some((r) => !r.ok);
    const hasPersist = scope.some(({ smoke }) =>
      smoke.some(
        (s) =>
          s.kind === "http" &&
          s.method === "GET" &&
          /\{\{(?!rand\}\})\w+\}\}/.test(JSON.stringify([s.path, s.body ?? null])),
      ),
    );
    if (hasPersist && !results.some((r) => r.id === "runtime:health:backend" && !r.ok)) {
      const restart = await docker([...files, "restart", contract.backend.service], {
        timeoutMs: 5 * 60_000,
        signal,
        cwd: copy,
      });
      checks.push({
        name: "persist:restart",
        status: restart.code === 0 ? "passed" : "failed",
        cause: restart.code === 0 ? undefined : classifyCause(restart.output),
        command: `docker compose restart ${contract.backend.service}`,
        output: tail(restart.output, 2000),
      });
      if (restart.code === 0)
        checks.push(...toChecks(parseRunnerResults((await probe("recheck")).output)));
    }
    const hasPages =
      !!contract.frontend && scope.some(({ smoke }) => smoke.some((s) => s.kind === "page"));
    if (hasPages) {
      const pages = await pageChecks(docker, network, specDir, outDir, signal);
      checks.push(...pages.checks);
      if (input.artifactsDir) {
        await fs.mkdir(input.artifactsDir, { recursive: true });
        for (const shot of pages.screenshots) {
          const local = path.join(outDir, "shots", path.basename(shot));
          const target = path.join(input.artifactsDir, path.basename(shot));
          if (
            await fs.copyFile(local, target).then(
              () => true,
              () => false,
            )
          )
            screenshots.push(target);
        }
      }
    }
    if (failedRuntime || checks.some((c) => c.status === "failed")) {
      const diag = await diagnostics();
      const firstFailed = checks.find((c) => c.status === "failed");
      if (firstFailed) firstFailed.output += diag;
    }
    return { checks, screenshots };
  } finally {
    await docker([...files, "down", "-v", "--remove-orphans", "--timeout", "10"], {
      timeoutMs: 5 * 60_000,
      cwd: copy,
    });
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function frontendHealth(
  docker: DockerRunner,
  network: string,
  contract: DeliveryContract,
  signal?: AbortSignal,
): Promise<RunnerResult> {
  const frontend = contract.frontend!;
  const url = `http://${frontend.service}:${frontend.port}${frontend.health ?? "/"}`;
  const script = `const u=${JSON.stringify(url)};const end=Date.now()+120000;let last="未响应";
while(Date.now()<end){try{const r=await fetch(u,{signal:AbortSignal.timeout(5000)});const t=await r.text();
if(r.status<400&&t.length>0){console.log("GS_RESULT "+JSON.stringify({id:"runtime:health:frontend",ok:true,detail:"HTTP "+r.status}));process.exit(0)}
last="HTTP "+r.status}catch(e){last=String(e?.cause?.code??e?.message??e)}await new Promise(r=>setTimeout(r,2000))}
console.log("GS_RESULT "+JSON.stringify({id:"runtime:health:frontend",ok:false,detail:"前端 120 秒内不可访问："+last}))`;
  const outcome = await docker(
    [
      "run",
      "--rm",
      ...hostUserArgs(),
      ...NO_NEW_PRIVILEGES,
      "--network",
      network,
      IMAGES.probe,
      "node",
      "--input-type=module",
      "-e",
      script,
    ],
    { timeoutMs: 4 * 60_000, signal },
  );
  return (
    parseRunnerResults(outcome.output)[0] ?? {
      id: "runtime:health:frontend",
      ok: false,
      detail: `前端探针未产生结果：${tail(outcome.output, 2000)}`,
    }
  );
}

async function pageChecks(
  docker: DockerRunner,
  network: string,
  specDir: string,
  outDir: string,
  signal?: AbortSignal,
): Promise<{ checks: GateCheck[]; screenshots: string[] }> {
  const version =
    process.env.GS_GATE_PLAYWRIGHT_VERSION?.trim() ||
    /:v(\d+\.\d+\.\d+)/.exec(IMAGES.playwright)?.[1] ||
    "1.49.1";
  const outcome = await docker(
    [
      // 唯一不加 NO_NEW_PRIVILEGES 的容器：Chromium 的 setuid 沙箱在该选项下起不来。
      "run",
      "--rm",
      ...hostUserArgs(),
      "--network",
      network,
      "--shm-size",
      "1g",
      ...cacheEnvArgs(),
      "-v",
      `${CACHE_VOLUME}:/cache`,
      "-v",
      `${RUNNER_DIR}:/runner:ro`,
      "-v",
      `${specDir}:/spec:ro`,
      "-v",
      `${outDir}:/out`,
      "--entrypoint",
      "sh",
      IMAGES.playwright,
      "-c",
      `mkdir -p /tmp/home /tmp/pw && cd /tmp/pw && npm init -y >/dev/null 2>&1 && npm i --no-audit --no-fund playwright@${version} >/tmp/pw/install.log 2>&1 || { cat /tmp/pw/install.log; exit 3; }; node /runner/page-runner.mjs`,
    ],
    { timeoutMs: 15 * 60_000, signal },
  );
  const results = parseRunnerResults(outcome.output);
  if (!results.length)
    return {
      checks: [
        {
          name: "runtime:browser",
          status: outcome.code === 3 ? "blocked" : "failed",
          cause: outcome.code === 3 ? "environment" : classifyCause(outcome.output),
          command: "playwright page-runner",
          output: tail(outcome.output),
        },
      ],
      screenshots: [],
    };
  return {
    checks: toChecks(results),
    screenshots: results.map((r) => r.screenshot).filter((s): s is string => !!s),
  };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                 */
/* ------------------------------------------------------------------ */

export async function runDeliveryGate(
  stage: string,
  options: DeliveryGateOptions = {},
): Promise<DeliveryGateResult> {
  const docker = options.docker ?? defaultDocker;
  const startedAt = new Date().toISOString();
  const checks: GateCheck[] = [];
  const expected: string[] = [];
  const screenshots: string[] = [];
  let tier: "fast" | "full" = options.tier === "full" ? "full" : "fast";
  let copy: string | undefined;
  try {
    options.signal?.throwIfAborted();
    copy = await fs.mkdtemp(path.join(os.tmpdir(), "gs-gate-"));
    try {
      await inventoryWorkspace(stage, copy);
    } catch (error) {
      checks.push({
        name: "workspace:copy",
        status: "failed",
        cause: "code",
        output: `无法复制工作区：${String(error instanceof Error ? error.message : error)}`,
      });
      return done();
    }
    await chmodTree(copy);
    const markers = await scanStackMarkers(copy);
    const composeFile = await findComposeFile(copy);
    const contractLoad = await loadDeliveryContract(copy);
    if (options.tier === "auto" || !options.tier)
      tier = composeFile || contractLoad.status !== "missing" ? "full" : "fast";

    if (!markers.length)
      checks.push({
        name: "stack:detect",
        status: "blocked",
        cause: "code",
        output:
          "工作区里没有识别到任何工程（package.json / pom.xml / pyproject.toml / requirements.txt 等）。",
      });
    for (const marker of unsupportedMarkers(markers))
      checks.push({
        name: `stack:${marker.root || "."}:${marker.kind}`,
        status: "blocked",
        cause: "environment",
        output: `识别到 ${marker.root || "."}/${marker.file}（${marker.kind}），平台尚无该技术栈的构建验证器。缺少验证不等于通过；请改用受支持的栈（Node / Maven / Python）或为平台补充检查器。`,
      });

    const supported = markers.filter((m) => ["node", "maven", "python"].includes(m.kind));
    // 先登记本次必须出现的检查：即使 Docker 不可用而提前返回，它们也会以 blocked 出现在报告里。
    for (const marker of supported) {
      const root = marker.root || ".";
      if (marker.kind === "node") expected.push(`${root}:build`, `${root}:test`);
      else if (marker.kind === "maven") expected.push(`${root}:maven:test`);
      else expected.push(`${root}:python:test`);
    }
    if (supported.length) {
      const cacheProblem = await ensureCacheVolume(docker, options.signal);
      if (cacheProblem) {
        checks.push({
          name: "gate:cache",
          status: "blocked",
          cause: "environment",
          output: tail(cacheProblem),
        });
        return done();
      }
    }
    for (const marker of supported) {
      options.signal?.throwIfAborted();
      if (marker.kind === "node")
        checks.push(...(await nodeChecks(docker, copy, marker, options.signal)));
      else if (marker.kind === "maven")
        checks.push(await mavenCheck(docker, copy, marker, options.signal));
      else checks.push(await pythonCheck(docker, copy, marker, options.signal));
    }

    if (tier === "full") {
      expected.push("delivery:compose", "delivery:contract");
      checks.push(
        composeFile
          ? { name: "delivery:compose", status: "passed", output: composeFile }
          : {
              name: "delivery:compose",
              status: "blocked",
              cause: "code",
              output:
                "项目根目录缺少 compose.yaml。交付物必须能用 `docker compose up` 一键启动（答辩演示同样依赖它）。",
            },
      );
      if (contractLoad.status !== "ok")
        checks.push({
          name: "delivery:contract",
          status: "blocked",
          cause: "code",
          output:
            contractLoad.status === "missing"
              ? `缺少 ${CONTRACT_PATH}（服务名/端口/健康检查/登录方式/演示账号）。`
              : `${CONTRACT_PATH} 格式无效：${contractLoad.error}`,
        });
      else {
        const contract = contractLoad.contract;
        const scope: SmokeScopeEntry[] = [
          ...(contract.smoke.length ? [{ moduleId: "skeleton", smoke: contract.smoke }] : []),
          ...(options.smoke ?? []),
        ];
        const roles = missingRoles(
          contract,
          scope.flatMap((s) => s.smoke),
        );
        checks.push(
          roles.length
            ? {
                name: "delivery:contract",
                status: "blocked",
                cause: "code",
                output: `冒烟检查引用的角色在契约 accounts 中不存在：${roles.join("、")}`,
              }
            : {
                name: "delivery:contract",
                status: "passed",
                output: `账号角色：${contract.accounts.map((a) => a.role).join("、") || "无"}`,
              },
        );
        const buildBroken = checks.some((c) => c.status === "failed");
        if (composeFile && !roles.length && !buildBroken) {
          expected.push(...expectedRuntimeChecks(contract, scope));
          const runtime = await runtimeChecks({
            docker,
            copy,
            composeFile,
            contract,
            scope,
            signal: options.signal,
            artifactsDir: options.artifactsDir,
          });
          checks.push(...runtime.checks);
          screenshots.push(...runtime.screenshots);
        } else if (buildBroken)
          checks.push({
            name: "runtime:skipped",
            status: "not_run",
            cause: "code",
            output: "构建或测试已失败，跳过运行时检查；先修复上面的失败项。",
          });
      }
    }
    return done();
  } catch (error) {
    checks.push({
      name: "gate:error",
      status: "blocked",
      cause: options.signal?.aborted ? "environment" : classifyCause(String(error), "environment"),
      output: options.signal?.aborted
        ? "闸门已取消。"
        : `闸门执行异常：${String(error instanceof Error ? error.message : error)}`,
    });
    return done();
  } finally {
    if (copy) await fs.rm(copy, { recursive: true, force: true }).catch(() => {});
  }

  function done(): DeliveryGateResult {
    const finalChecks = finalizeChecks(checks, expected).map((c) => ({
      ...c,
      output: redactKnownSecrets(c.output),
    }));
    return {
      version: 1,
      status: decideGateStatus(finalChecks),
      tier,
      checks: finalChecks,
      screenshots,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

async function chmodTree(root: string) {
  // 容器内以非宿主用户写入构建产物时需要写权限（Linux 宿主上已用宿主 uid 运行，这里是兜底）。
  const visit = async (dir: string) => {
    await fs.chmod(dir, 0o777).catch(() => {});
    for (const entry of await fs.readdir(dir, { withFileTypes: true }))
      if (entry.isDirectory()) await visit(path.join(dir, entry.name));
  };
  await visit(root);
}

/** 人读摘要：用于步骤标题与变更集说明。 */
export function summarizeGate(result: DeliveryGateResult): string {
  const passed = result.checks.filter((c) => c.status === "passed").length;
  const bad = result.checks.filter((c) => c.status !== "passed").map((c) => c.name);
  return `${result.status}（${result.tier ?? "?"}，${passed}/${result.checks.length} 通过${bad.length ? `；未通过：${bad.slice(0, 6).join("、")}${bad.length > 6 ? "…" : ""}` : ""}）`;
}
