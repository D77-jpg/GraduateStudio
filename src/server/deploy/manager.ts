import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { resolveProjectDir, safeJoin } from "@/server/workspace/paths";

/**
 * Phase 11:部署中心(本地 Docker 优先)。
 * 生命周期:generate-assets(AI 生成)→ build(compose build,真实子进程)→
 * deploy(up -d + 端口探测)→ logs/restart/stop/rollback(TAG 切换历史镜像)。
 * 日志真实来源于 docker 命令输出,环形缓冲;不做任何云平台真实集成。
 */

const execFileAsync = promisify(execFile);

export const DEPLOY_WEB_PORT = 8180;
export const DEPLOY_API_PORT = 8181;
export const MAX_DEPLOY_LOGS = 2000;

export class DeployError extends Error {
  code: string;
  constructor(message: string, code = "deploy_error") {
    super(message);
    this.name = "DeployError";
    this.code = code;
  }
}

export interface DeployLogLine {
  seq: number;
  stream: "out" | "err" | "system";
  text: string;
  at: number;
}

export interface DeployRecord {
  tag: string;
  deployedAt: string;
  gitCommit: string | null;
  note: string;
}

export interface DeployState {
  projectId: string;
  status: "idle" | "building" | "deploying" | "running" | "stopped" | "failed";
  lastError: string | null;
  logs: DeployLogLine[];
  seq: number;
  startedAt: number | null;
  currentTag: string | null;
  history: DeployRecord[];
  runningProc: ReturnType<typeof spawn> | null;
}

const states = new Map<string, DeployState>();

const historyPath = (projectId: string) =>
  safeJoin(resolveProjectDir(projectId), ".gs", "deploy-history.json");

/** 部署历史持久化到工作区(.gs/deploy-history.json),平台重启不丢。 */
function loadHistory(projectId: string): DeployRecord[] {
  try {
    const raw = fs.readFileSync(historyPath(projectId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as DeployRecord[]).slice(0, 10) : [];
  } catch {
    return [];
  }
}

function saveHistory(projectId: string, history: DeployRecord[]): void {
  try {
    const file = historyPath(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(history, null, 1), "utf8");
  } catch {
    /* 历史写盘失败不影响部署 */
  }
}

function getState(projectId: string): DeployState {
  let state = states.get(projectId);
  if (!state) {
    state = {
      projectId,
      status: "idle",
      lastError: null,
      logs: [],
      seq: 0,
      startedAt: null,
      currentTag: null,
      history: loadHistory(projectId),
      runningProc: null,
    };
    states.set(projectId, state);
  }
  return state;
}

function appendLog(state: DeployState, stream: DeployLogLine["stream"], text: string): void {
  state.logs.push({ seq: ++state.seq, stream, text, at: Date.now() });
  if (state.logs.length > MAX_DEPLOY_LOGS) {
    state.logs.splice(0, state.logs.length - MAX_DEPLOY_LOGS);
  }
}

export function getDeployLogsSince(
  projectId: string,
  since: number,
): { logs: DeployLogLine[]; nextSeq: number; status: string } {
  const state = getState(projectId);
  return {
    logs: state.logs.filter((l) => l.seq > since),
    nextSeq: state.seq,
    status: state.status,
  };
}

export function getDeployStatus(projectId: string): {
  status: string;
  currentTag: string | null;
  history: DeployRecord[];
  lastError: string | null;
  assetsReady: boolean;
  dockerAvailable: boolean;
  webPort: number;
  apiPort: number;
} {
  const state = getState(projectId);
  const projectDir = resolveProjectDir(projectId);
  return {
    status: state.status,
    currentTag: state.currentTag,
    history: state.history,
    lastError: state.lastError,
    assetsReady: fs.existsSync(path.join(projectDir, "docker-compose.yml")),
    dockerAvailable: dockerAvailableCache,
    webPort: DEPLOY_WEB_PORT,
    apiPort: DEPLOY_API_PORT,
  };
}

let dockerAvailableCache = false;
let dockerCheckedAt = 0;

/** 检测 docker daemon(缓存 60 秒)。 */
export async function checkDockerAvailable(): Promise<boolean> {
  if (Date.now() - dockerCheckedAt < 60_000) return dockerAvailableCache;
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 15_000,
      windowsHide: true,
    });
    dockerAvailableCache = true;
  } catch {
    dockerAvailableCache = false;
  }
  dockerCheckedAt = Date.now();
  return dockerAvailableCache;
}

const IMAGE_BASE = (projectId: string) => `gs-${projectId.slice(0, 8)}`;

/** 部署日志的公共前缀参数:项目名隔离,compose 文件在工作区根。 */
function composeArgs(projectId: string, args: string[]): string[] {
  return ["compose", "-p", IMAGE_BASE(projectId), ...args];
}

/** 流式执行 docker 命令,输出进部署日志。 */
function runDockerStreaming(
  state: DeployState,
  projectId: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 900_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    appendLog(state, "system", `$ docker ${args.join(" ")}`);
    const proc = spawn("docker", args, {
      cwd: resolveProjectDir(projectId),
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    state.runningProc = proc;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    let tail = "";
    const collect = (chunk: string, stream: "out" | "err") => {
      const lines = (tail + chunk).split(/\r?\n/);
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) appendLog(state, stream, line.slice(0, 400));
      }
    };
    proc.stdout.on("data", (d) => collect(String(d), "out"));
    proc.stderr.on("data", (d) => collect(String(d), "err"));
    proc.on("error", (e) => {
      clearTimeout(timer);
      state.runningProc = null;
      reject(new DeployError(`docker 启动失败:${e.message}`, "docker_spawn"));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      state.runningProc = null;
      if (tail.trim()) appendLog(state, "err", tail.slice(0, 400));
      if (timedOut) reject(new DeployError("docker 命令超时", "docker_timeout"));
      else if (code !== 0)
        reject(new DeployError(`docker 退出码 ${code}(详情见日志)`, "docker_exit"));
      else resolve();
    });
  });
}

/** 资产是否齐备(compose + 两个 Dockerfile)。 */
function assertAssets(projectId: string): void {
  const dir = resolveProjectDir(projectId);
  if (
    !fs.existsSync(path.join(dir, "docker-compose.yml")) ||
    !fs.existsSync(safeJoin(dir, "deploy", "Dockerfile.web"))
  ) {
    throw new DeployError("部署资产尚未生成,请先点击「AI 生成部署资产」", "no_assets");
  }
}

/** compose 变量源初始化:项目根没有 .env 时,从 deploy/.env.example 复制(真实部署流程的标准动作)。 */
function ensureComposeEnv(projectId: string): void {
  const dir = resolveProjectDir(projectId);
  const envPath = path.join(dir, ".env");
  if (fs.existsSync(envPath)) return;
  const example = safeJoin(dir, "deploy", ".env.example");
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, envPath);
    const state = getState(projectId);
    appendLog(
      state,
      "system",
      "[deploy] 已从 deploy/.env.example 初始化 .env(compose 变量源),请按需修改密钥/密码",
    );
  }
}

/** 最近一次成功部署的 git commit(用于历史记录)。 */
async function latestCommit(projectId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: resolveProjectDir(projectId),
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function waitForHttp(port: number, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const targets = ["127.0.0.1", "[::1]"];
  while (Date.now() < deadline) {
    for (const host of targets) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_500);
        const res = await fetch(`http://${host}:${port}/`, { signal: controller.signal });
        clearTimeout(timer);
        if (res.status < 599) return true;
      } catch {
        /* retry */
      }
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return false;
}

/** Build:compose build(真实),完成后补打时间戳 tag。 */
export async function buildDeployment(projectId: string): Promise<{ status: string; tag: string }> {
  if (!(await checkDockerAvailable())) {
    throw new DeployError("Docker 不可用:请确认 Docker Desktop 正在运行", "no_docker");
  }
  const state = getState(projectId);
  if (state.status === "building" || state.status === "deploying") {
    throw new DeployError("已有部署操作在进行中", "busy");
  }
  assertAssets(projectId);
  ensureComposeEnv(projectId);
  const tag = `${Date.now()}`;
  state.status = "building";
  state.startedAt = Date.now();
  state.lastError = null;
  appendLog(state, "system", `[deploy] 开始构建镜像(前端 + 后端)…`);
  try {
    await runDockerStreaming(
      state,
      projectId,
      composeArgs(projectId, ["build", "--pull"]),
      {},
      900_000,
    );
    await runDockerStreaming(
      state,
      projectId,
      ["tag", `${IMAGE_BASE(projectId)}-web:latest`, `${IMAGE_BASE(projectId)}-web:${tag}`],
      {},
      60_000,
    );
    await runDockerStreaming(
      state,
      projectId,
      ["tag", `${IMAGE_BASE(projectId)}-api:latest`, `${IMAGE_BASE(projectId)}-api:${tag}`],
      {},
      60_000,
    );
    appendLog(state, "system", `[deploy] 构建完成,镜像 tag:${tag}`);
    state.status = "stopped";
    const commit = await latestCommit(projectId);
    state.history.unshift({
      tag,
      deployedAt: new Date().toISOString(),
      gitCommit: commit,
      note: "镜像构建(未部署)",
    });
    if (state.history.length > 10) state.history.pop();
    saveHistory(projectId, state.history);
    return { status: state.status, tag };
  } catch (e) {
    state.status = "failed";
    state.lastError = e instanceof Error ? e.message : String(e);
    appendLog(state, "system", `[deploy] 构建失败:${state.lastError}`);
    throw e;
  }
}

/** Deploy:up -d(可选指定历史 TAG),端口探测成功记历史。 */
export async function deployUp(
  projectId: string,
  opts: { tag?: string; note?: string } = {},
): Promise<{ status: string; tag: string }> {
  if (!(await checkDockerAvailable())) {
    throw new DeployError("Docker 不可用:请确认 Docker Desktop 正在运行", "no_docker");
  }
  const state = getState(projectId);
  if (state.status === "building" || state.status === "deploying") {
    throw new DeployError("已有部署操作在进行中", "busy");
  }
  assertAssets(projectId);
  ensureComposeEnv(projectId);
  const tag = opts.tag ?? "latest";
  state.status = "deploying";
  state.startedAt = Date.now();
  state.lastError = null;
  appendLog(state, "system", `[deploy] 启动容器(image tag:${tag})…`);
  try {
    // 带上之前 up 留下的资源干净启动(保留卷数据)
    await runDockerStreaming(
      state,
      projectId,
      composeArgs(projectId, ["down", "--remove-orphans"]),
      { TAG: tag },
      120_000,
    );
    await runDockerStreaming(
      state,
      projectId,
      composeArgs(projectId, ["up", "-d"]),
      { TAG: tag },
      180_000,
    );
    const ok = await waitForHttp(DEPLOY_WEB_PORT, 90_000);
    const commit = await latestCommit(projectId);
    const record: DeployRecord = {
      tag,
      deployedAt: new Date().toISOString(),
      gitCommit: commit,
      note: opts.note ?? (tag === "latest" ? "部署最新构建" : `回滚到 ${tag}`),
    };
    state.history.unshift(record);
    if (state.history.length > 10) state.history.pop();
    saveHistory(projectId, state.history);
    state.currentTag = tag;
    if (!ok) {
      state.status = "failed";
      state.lastError = `容器已启动,但 ${DEPLOY_WEB_PORT} 端口在 90 秒内未就绪(查看日志排查)`;
      appendLog(state, "system", `[deploy] ${state.lastError}`);
      throw new DeployError(state.lastError, "port_not_ready");
    }
    state.status = "running";
    appendLog(
      state,
      "system",
      `[deploy] 部署完成:http://localhost:${DEPLOY_WEB_PORT}(API:${DEPLOY_API_PORT})`,
    );
    return { status: state.status, tag };
  } catch (e) {
    if (state.status !== "failed") {
      state.status = "failed";
      state.lastError = e instanceof Error ? e.message : String(e);
      appendLog(state, "system", `[deploy] 部署失败:${state.lastError}`);
    }
    throw e;
  }
}

/** 拉取容器日志(docker compose logs --tail)写入状态环。 */
export async function fetchContainerLogs(projectId: string, tail = 300): Promise<void> {
  const state = getState(projectId);
  if (!(await checkDockerAvailable())) {
    throw new DeployError("Docker 不可用", "no_docker");
  }
  try {
    await runDockerStreaming(
      state,
      projectId,
      composeArgs(projectId, ["logs", `--tail=${tail}`]),
      {},
      60_000,
    );
    appendLog(state, "system", "[deploy] —— 以上为容器最新日志 ——");
  } catch {
    appendLog(state, "system", "[deploy] 没有正在运行的容器可读取日志");
  }
}

/** Restart:compose restart。 */
export async function restartDeployment(projectId: string): Promise<{ status: string }> {
  const state = getState(projectId);
  if (!(await checkDockerAvailable())) throw new DeployError("Docker 不可用", "no_docker");
  state.status = "deploying";
  appendLog(state, "system", "[deploy] 重启容器…");
  try {
    await runDockerStreaming(state, projectId, composeArgs(projectId, ["restart"]), {}, 180_000);
    const ok = await waitForHttp(DEPLOY_WEB_PORT, 60_000);
    state.status = ok ? "running" : "failed";
    if (!ok) {
      state.lastError = `重启后 ${DEPLOY_WEB_PORT} 端口未就绪`;
      appendLog(state, "system", `[deploy] ${state.lastError}`);
    } else {
      appendLog(state, "system", `[deploy] 重启完成,服务已恢复`);
    }
    return { status: state.status };
  } catch (e) {
    state.status = "failed";
    state.lastError = e instanceof Error ? e.message : String(e);
    throw e;
  }
}

/** Stop:compose down(保留数据卷)。 */
export async function stopDeployment(projectId: string): Promise<{ status: string }> {
  const state = getState(projectId);
  if (!(await checkDockerAvailable())) throw new DeployError("Docker 不可用", "no_docker");
  appendLog(state, "system", "[deploy] 停止并移除容器(数据卷保留)…");
  try {
    await runDockerStreaming(
      state,
      projectId,
      composeArgs(projectId, ["down", "--remove-orphans"]),
      {},
      120_000,
    );
    state.status = "stopped";
    return { status: state.status };
  } catch (e) {
    state.status = "failed";
    state.lastError = e instanceof Error ? e.message : String(e);
    throw e;
  }
}

/** Rollback:回滚到历史记录中的镜像 tag。 */
export async function rollbackDeployment(
  projectId: string,
  tag: string,
): Promise<{ status: string; tag: string }> {
  const state = getState(projectId);
  if (!/^\d{10,16}$/.test(tag) && tag !== "latest") {
    throw new DeployError("非法的镜像 tag", "invalid_tag");
  }
  const known = state.history.some((h) => h.tag === tag);
  if (!known) {
    // 兜底:验证本地镜像存在
    try {
      await execFileAsync("docker", ["image", "inspect", `${IMAGE_BASE(projectId)}-web:${tag}`], {
        timeout: 15_000,
        windowsHide: true,
      });
    } catch {
      throw new DeployError("本地不存在该版本的镜像,无法回滚", "tag_not_found");
    }
  }
  appendLog(state, "system", `[deploy] 回滚到镜像 ${tag}…`);
  const result = await deployUp(projectId, { tag, note: `回滚到 ${tag}` });
  return result;
}
