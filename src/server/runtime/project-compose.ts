import { createServer } from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dependencyDocker } from "../agents/codex-dependency-network";

/**
 * 工作台托管项目自带 compose 的启动/停止边界。
 *
 * 只使用工作区根目录下固定文件名的 compose 文件；容器、网络、卷都以
 * `gs-<projectId 前 8 位>` 作为 compose 项目名,并在每次 up 前后校验
 * `com.docker.compose.project` 标签,拒绝接管其他来源的同名项目。
 * 所有 docker 调用经 dependencyDocker(不经过 shell),原始输出只用于本地
 * 解析,永远不会进入日志或错误信息;对调用方只回固定中文提示。
 */

const COMPOSE_FILE_NAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
] as const;
const MAX_COMPOSE_BYTES = 128 * 1024;
const MAX_PROJECT_ENV_BYTES = 64 * 1024;
const MAX_PORT_VARIABLES = 32;
const MAX_PORT_ATTEMPTS = 3;
const MAX_DEFAULT_VARIABLES = 64;
const MAX_DEFAULT_VALUE_LENGTH = 256;

const UP_TIMEOUT_MS = 180_000;
const DOWN_TIMEOUT_MS = 180_000;
const INSPECT_TIMEOUT_MS = 30_000;
const PS_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 120_000;
const READY_INTERVAL_MS = 1_000;

const PROJECT_LABEL = "com.docker.compose.project";
const API_SERVICE = /^api$|backend|server|app$/i;
const PORT_MAPPING = /(?:^|[^\d])(\d{1,5})->\d{1,5}\/(?:tcp|udp)/gi;
const VARIABLE_PATTERN =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-)([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const DEFAULT_NAME = /^[A-Z0-9_]{1,64}$/;

// 固定中文错误:不包含路径、环境变量、密钥或任何 docker 原始输出。
const ERROR_IDENTITY = "项目标识无效，无法确定 compose 项目名";
const ERROR_OWNERSHIP = "检测到不属于本项目的 compose 资源，已拒绝操作";
const ERROR_PORT_BUSY = "项目声明的端口被占用，无法启动 compose";
const ERROR_START = "compose 服务启动失败";
const ERROR_STOP = "compose 服务停止失败";
const ERROR_READY = "compose 服务未在时限内就绪";
const ERROR_ABORTED = "compose 操作已取消";

class ComposeOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeOperationError";
  }
}

export interface ProjectComposeLocation {
  file: string;
  directory: string;
}

export interface ProjectComposeService {
  name: string;
  state: string;
  health: string | null;
  ports: number[];
}

export interface ProjectComposeStartResult {
  project: string;
  directory: string;
  file: string;
  services: ProjectComposeService[];
  apiTarget: string | null;
  /** compose 变量默认值 ∪ 本次端口冲突覆盖值;供后续后端进程复用同一组变量。 */
  env: Record<string, string>;
}

export interface StartProjectComposeOptions {
  projectId: string;
  projectDir: string;
  log?: (message: string) => void;
  signal?: AbortSignal;
  allocatePort?: (key: string) => Promise<number>;
}

export interface StopProjectComposeOptions {
  projectId: string;
  projectDir: string;
  /** 调用方可直接传入 detectProjectCompose 的结果,避免重复检测。 */
  file?: string;
  directory?: string;
  signal?: AbortSignal;
}

interface PortVariable {
  name: string;
  fallback: string | null;
}

interface ComposePsRow {
  service: string;
  container: string;
  state: string;
  health: string | null;
  ports: number[];
}

interface ComposeEnvironment {
  directory: string;
  file: string;
}

/** 只认项目根目录的固定文件名:普通文件、非符号链接、不超过 128KiB。 */
export function detectProjectCompose(projectDir: string): ProjectComposeLocation | null {
  const directory = path.resolve(projectDir);
  for (const name of COMPOSE_FILE_NAMES) {
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_COMPOSE_BYTES) continue;
      return { file, directory };
    } catch {
      // 不存在或无法读取的候选文件直接跳过,继续下一个白名单文件名。
    }
  }
  return null;
}

/** `gs-` + projectId 前 8 位,例如 cmuwb4h6... -> gs-cmuwb4h6(与既有容器一致)。 */
export function composeProjectName(projectId: string): string {
  const prefix = typeof projectId === "string" ? projectId.slice(0, 8) : "";
  if (prefix.length !== 8 || !/^[a-z0-9]{8}$/.test(prefix))
    throw new ComposeOperationError(ERROR_IDENTITY);
  return `gs-${prefix}`;
}

/** ports 段里 ${VAR} / ${VAR:-default} / ${VAR-default} / $VAR 的变量名,去重且最多 32 个。 */
export function readComposePortVariables(text: string): string[] {
  return composePortVariables(text)
    .slice(0, MAX_PORT_VARIABLES)
    .map((entry) => entry.name);
}

/**
 * 整份 compose 文本里 ${VAR:-default} / ${VAR-default} 的默认值。
 * 只收 [A-Z0-9_]{1,64} 变量名,值截断 256 字符,最多 64 条;空默认值不导出。
 */
export function composeVariableDefaults(fileText: string): Record<string, string> {
  const defaults: Record<string, string> = {};
  let count = 0;
  for (const match of fileText.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (!name || !DEFAULT_NAME.test(name) || !match[2]) continue;
    const value = normalizeDefaultValue(match[3] ?? "");
    if (!value) continue;
    if (Object.prototype.hasOwnProperty.call(defaults, name)) continue;
    if (count >= MAX_DEFAULT_VARIABLES) break;
    defaults[name] = value.slice(0, MAX_DEFAULT_VALUE_LENGTH);
    count += 1;
  }
  return defaults;
}

export async function startProjectCompose(
  options: StartProjectComposeOptions,
): Promise<ProjectComposeStartResult | null> {
  const detected = detectProjectCompose(options.projectDir);
  // 没有 compose 时立即返回,不执行任何 docker 命令。
  if (!detected) return null;
  const name = composeProjectName(options.projectId);
  const text = readComposeText(detected.file);
  const defaults = composeVariableDefaults(text);
  let environment: ComposeEnvironment | null = null;
  try {
    options.signal?.throwIfAborted();
    // up 之前先确认同名 compose 项目的容器确实属于我们,避免劫持别人的项目。
    await assertComposeOwnership(name, options.signal);
    options.log?.("检测到项目 compose 配置，准备启动。");
    const overrides = await resolvePortOverrides({
      projectId: options.projectId,
      text,
      allocatePort: options.allocatePort,
      signal: options.signal,
    });
    if (Object.keys(overrides).length)
      environment = await createComposeEnvironmentFile(detected.directory, overrides);
    const prefix = composeArguments(name, detected.directory, detected.file, environment?.file);
    options.signal?.throwIfAborted();
    options.log?.("正在启动项目 compose 服务。");
    // dependencyDocker 不接受 env,端口覆盖值经 compose 的 --env-file 注入;
    // 输出上限(64KiB)由该命令执行边界统一保证,这里不接触原始输出。
    await dependencyDocker(
      [...prefix, "up", "-d", "--remove-orphans"],
      options.signal,
      UP_TIMEOUT_MS,
    );
    // up 之后再校验一次,防止 up 过程中项目名被其他来源占用。
    await assertComposeOwnership(name, options.signal);
    options.log?.("正在等待 compose 服务就绪。");
    const rows = await waitForComposeReady(prefix, options.signal);
    const services = mergeServices(rows);
    options.log?.("项目 compose 服务已就绪。");
    return {
      project: name,
      directory: detected.directory,
      file: detected.file,
      services,
      apiTarget: composeApiTarget(services),
      env: { ...defaults, ...overrides },
    };
  } catch (error) {
    if (error instanceof ComposeOperationError) throw error;
    if (options.signal?.aborted) throw new ComposeOperationError(ERROR_ABORTED);
    throw new ComposeOperationError(ERROR_START);
  } finally {
    if (environment)
      try {
        await fsp.rm(environment.directory, { recursive: true, force: true });
      } catch {
        // 临时环境文件清理失败不影响启动结果。
      }
  }
}

export async function stopProjectCompose(options: StopProjectComposeOptions): Promise<boolean> {
  const detected = locateCompose(options);
  // 没有 compose 时返回 false,且不执行任何 docker 命令。
  if (!detected) return false;
  const name = composeProjectName(options.projectId);
  try {
    const existing = await assertComposeOwnership(name, options.signal);
    // 没有本项目容器时不做任何改变,也不报错。
    if (existing === 0) return false;
    await dependencyDocker(
      [...composeArguments(name, detected.directory, detected.file), "down"],
      options.signal,
      DOWN_TIMEOUT_MS,
    );
    return true;
  } catch (error) {
    if (error instanceof ComposeOperationError) throw error;
    if (options.signal?.aborted) throw new ComposeOperationError(ERROR_ABORTED);
    throw new ComposeOperationError(ERROR_STOP);
  }
}

function locateCompose(options: StopProjectComposeOptions): ProjectComposeLocation | null {
  if (options.file && options.directory)
    return { file: path.resolve(options.file), directory: path.resolve(options.directory) };
  return detectProjectCompose(options.projectDir);
}

function readComposeText(file: string): string {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_COMPOSE_BYTES) throw new Error();
    return fs.readFileSync(file, "utf8");
  } catch {
    throw new ComposeOperationError(ERROR_START);
  }
}

function indentationWidth(line: string): number {
  return (/^[ \t]*/.exec(line)?.[0] ?? "").replace(/\t/g, "  ").length;
}

/** 收集 ports 段内的文本行(含同一行的 flow 列表),用于只解析端口映射。 */
function portsLines(text: string): string[] {
  const lines: string[] = [];
  let sectionIndent = -1;
  for (const raw of text.split(/\r?\n/)) {
    const declaration = /^([ \t]*)(?:-[ \t]+)?ports[ \t]*:(.*)$/.exec(raw);
    if (declaration) {
      sectionIndent = indentationWidth(declaration[1]);
      lines.push(declaration[2]);
      continue;
    }
    if (sectionIndent < 0) continue;
    if (!raw.trim() || /^[ \t]*#/.test(raw)) continue;
    const indentation = indentationWidth(raw);
    const listItem = /^[ \t]*-[ \t]/.test(raw);
    if (indentation < sectionIndent || (indentation === sectionIndent && !listItem)) {
      sectionIndent = -1;
      continue;
    }
    lines.push(raw);
  }
  return lines;
}

function composePortVariables(text: string): PortVariable[] {
  const collected = new Map<string, string | null>();
  for (const line of portsLines(text)) {
    for (const match of line.matchAll(VARIABLE_PATTERN)) {
      const name = match[1] ?? match[4];
      if (!name) continue;
      const fallback = match[3] === undefined ? null : normalizeDefaultValue(match[3]);
      if (!collected.has(name)) collected.set(name, fallback);
      else if (collected.get(name) === null && fallback) collected.set(name, fallback);
    }
  }
  return [...collected].map(([name, fallback]) => ({ name, fallback }));
}

function normalizeDefaultValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote))
      return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      probe.removeAllListeners();
      try {
        probe.close();
      } catch {
        // 探测从未进入 listening 状态。
      }
      resolve(available);
    };
    probe.once("error", () => finish(false));
    probe.once("listening", () => finish(true));
    try {
      probe.listen({ port, host: "127.0.0.1", exclusive: true });
    } catch {
      // 无法判定时按已占用处理,避免复用可能被占用的端口。
      finish(false);
    }
  });
}

function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    const fail = () => reject(new ComposeOperationError(ERROR_PORT_BUSY));
    probe.once("error", fail);
    probe.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close(() => {
        if (Number.isInteger(port) && port >= 1 && port <= 65535) resolve(port);
        else fail();
      });
    });
  });
}

interface PortOverrideInput {
  projectId: string;
  text: string;
  allocatePort?: (key: string) => Promise<number>;
  signal?: AbortSignal;
}

/** 端口变量默认值被占用时重新分配,最多 3 轮;仍冲突则回固定中文错误。 */
async function resolvePortOverrides(input: PortOverrideInput): Promise<Record<string, string>> {
  const candidates = composePortVariables(input.text)
    .slice(0, MAX_PORT_VARIABLES)
    .map((entry) => ({ name: entry.name, port: Number(entry.fallback) }))
    .filter((entry) => Number.isInteger(entry.port) && entry.port >= 1 && entry.port <= 65535);
  const overrides = new Map<string, number>();
  if (!candidates.length) return {};
  const allocate = input.allocatePort ?? (() => allocateEphemeralPort());
  const conflicts = async () => {
    const busy: string[] = [];
    for (const candidate of candidates) {
      const port = overrides.get(candidate.name) ?? candidate.port;
      if (!(await isPortAvailable(port))) busy.push(candidate.name);
    }
    return busy;
  };
  let pending = false;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    input.signal?.throwIfAborted();
    const busy = await conflicts();
    if (!busy.length) {
      pending = false;
      break;
    }
    pending = true;
    for (const name of busy) {
      const port = await allocate(`compose:${input.projectId}:${name}`);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new ComposeOperationError(ERROR_PORT_BUSY);
      overrides.set(name, port);
    }
  }
  if (pending && (await conflicts()).length) throw new ComposeOperationError(ERROR_PORT_BUSY);
  const result: Record<string, string> = {};
  for (const [name, port] of overrides) result[name] = String(port);
  return result;
}

async function projectEnvLines(projectDirectory: string): Promise<string[]> {
  const file = path.join(projectDirectory, ".env");
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROJECT_ENV_BYTES) return [];
    const text = await fsp.readFile(file, "utf8");
    return text.split(/\r?\n/).filter((line) => line.trim() && !/^[ \t]*#/.test(line));
  } catch {
    return [];
  }
}

/**
 * compose 的 --env-file 会取代项目 .env,因此把项目已有取值作为基底,
 * 再追加本次端口覆盖值;临时目录 0700、文件 0600,启动结束立即删除。
 */
async function createComposeEnvironmentFile(
  projectDirectory: string,
  overrides: Record<string, string>,
): Promise<ComposeEnvironment> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "gs-compose-env-"));
  const file = path.join(directory, "compose.env");
  const overridden = new Set(Object.keys(overrides));
  try {
    const base = (await projectEnvLines(projectDirectory)).filter((line) => {
      const key = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/.exec(line)?.[1];
      return !key || !overridden.has(key);
    });
    const content = [
      ...base,
      ...Object.entries(overrides).map(([key, value]) => `${key}=${value}`),
    ].join("\n");
    await fsp.writeFile(file, content ? `${content}\n` : "", { mode: 0o600, flag: "wx" });
    return { directory, file };
  } catch (error) {
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function composeArguments(
  name: string,
  directory: string,
  file: string,
  environmentFile?: string,
): string[] {
  return [
    "compose",
    ...(environmentFile ? ["--env-file", environmentFile] : []),
    "-p",
    name,
    "--project-directory",
    directory,
    "-f",
    file,
  ];
}

async function composeContainerIds(name: string, signal?: AbortSignal): Promise<string[]> {
  const output = await dependencyDocker(
    ["ps", "--all", "--filter", `label=${PROJECT_LABEL}=${name}`, "--format", "{{.ID}}"],
    signal,
    INSPECT_TIMEOUT_MS,
  );
  return output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** 返回同名 compose 项目的容器数量;容器标签必须全部属于本项目,否则拒绝。 */
async function assertComposeOwnership(name: string, signal?: AbortSignal): Promise<number> {
  const ids = await composeContainerIds(name, signal);
  if (!ids.length) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await dependencyDocker(["container", "inspect", ...ids], signal, INSPECT_TIMEOUT_MS),
    );
  } catch {
    throw new ComposeOperationError(ERROR_OWNERSHIP);
  }
  if (!Array.isArray(parsed) || parsed.length !== ids.length)
    throw new ComposeOperationError(ERROR_OWNERSHIP);
  for (const entry of parsed) {
    const labels = (entry as { Config?: { Labels?: Record<string, string> } } | null)?.Config
      ?.Labels;
    if (!labels || labels[PROJECT_LABEL] !== name) throw new ComposeOperationError(ERROR_OWNERSHIP);
  }
  return ids.length;
}

function publishedPorts(value: unknown): number[] {
  const ports: number[] = [];
  const add = (port: number) => {
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && !ports.includes(port))
      ports.push(port);
  };
  const addText = (text: string) => {
    for (const match of text.matchAll(PORT_MAPPING)) add(Number(match[1]));
  };
  if (typeof value === "string") addText(value);
  else if (Array.isArray(value))
    for (const item of value) {
      if (typeof item === "string") addText(item);
      else if (item && typeof item === "object") {
        const published = (item as Record<string, unknown>).Published;
        if (typeof published === "string" || typeof published === "number") add(Number(published));
      }
    }
  return ports;
}

function normalizeComposeRow(value: unknown): ComposePsRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === "string" ? field.trim() : "");
  const service = text(item.Service);
  const container = text(item.Name) || text(item.Names);
  if (!service && !container) return null;
  const health = text(item.Health);
  return {
    service: service || container,
    container,
    state: text(item.State),
    health: health || null,
    ports: publishedPorts(item.Ports),
  };
}

/** 兼容 NDJSON 与 JSON 数组两种 `compose ps --format json` 输出,脏行忽略。 */
function parseComposePs(output: string): ComposePsRow[] {
  const text = output.trim();
  if (!text) return [];
  const rows: ComposePsRow[] = [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed))
        for (const item of parsed) {
          const row = normalizeComposeRow(item);
          if (row) rows.push(row);
        }
    } catch {
      // 不是合法数组时退回逐行解析。
    }
  }
  if (!rows.length)
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (!value.startsWith("{")) continue;
      try {
        const row = normalizeComposeRow(JSON.parse(value));
        if (row) rows.push(row);
      } catch {
        // 忽略脏行。
      }
    }
  return rows;
}

function composeReady(rows: ComposePsRow[]): boolean {
  return (
    rows.length > 0 &&
    rows.every(
      (row) =>
        /running/i.test(row.state) &&
        (row.health === null || row.health.toLowerCase() === "healthy"),
    )
  );
}

async function waitForComposeReady(
  prefix: string[],
  signal?: AbortSignal,
): Promise<ComposePsRow[]> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (true) {
    signal?.throwIfAborted();
    let rows: ComposePsRow[] = [];
    try {
      rows = parseComposePs(
        await dependencyDocker([...prefix, "ps", "--format", "json"], signal, PS_TIMEOUT_MS),
      );
    } catch (error) {
      // 单次 ps 失败视为暂未就绪;中止信号仍然立即生效。
      if (signal?.aborted) throw error;
    }
    if (composeReady(rows)) return rows;
    if (Date.now() >= deadline) throw new ComposeOperationError(ERROR_READY);
    await new Promise<void>((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
  }
}

function mergeServices(rows: ComposePsRow[]): ProjectComposeService[] {
  const services = new Map<string, ProjectComposeService>();
  for (const row of rows) {
    const existing = services.get(row.service);
    if (!existing) {
      services.set(row.service, {
        name: row.service,
        state: row.state,
        health: row.health,
        ports: [...row.ports],
      });
      continue;
    }
    for (const port of row.ports) if (!existing.ports.includes(port)) existing.ports.push(port);
    if (!/running/i.test(row.state)) existing.state = row.state;
    if (row.health && row.health.toLowerCase() !== "healthy") existing.health = row.health;
  }
  return [...services.values()];
}

/** 只按服务名匹配 api/backend/server/app,取第一个发布端口,不猜内部端口。 */
function composeApiTarget(services: ProjectComposeService[]): string | null {
  for (const service of services)
    if (API_SERVICE.test(service.name) && service.ports.length)
      return `http://127.0.0.1:${service.ports[0]}`;
  return null;
}
