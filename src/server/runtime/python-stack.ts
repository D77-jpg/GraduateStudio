import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { dependencyDocker, withDependencyNetwork } from "../agents/codex-dependency-network";
import { collectCodexPythonRequirements } from "../agents/codex-python-verification";

const OWNER = "io.graduatestudio.python-runtime";
const VERSION = "1";
const WORKER_IMAGE = "gs-codex-worker:0.150.1";
const ROLES = [
  "download",
  "prepare",
  "mysql",
  "redis",
  "bootstrap",
  "backend",
  "worker",
  "beat",
  "ingress",
] as const;
const active = new Set<string>();
type Role = (typeof ROLES)[number];
type Labels = Record<string, string>;

/** IDs, never user-controlled names or paths, form the resource namespace. */
export function pythonStackIdentity(projectId: string) {
  if (!projectId || projectId.length > 512 || /[\x00-\x1f]/.test(projectId))
    throw new Error("Invalid Python runtime project identity.");
  const key = createHash("sha256").update(projectId).digest("hex");
  const prefix = `gs-python-${key.slice(0, 24)}`;
  return {
    key,
    prefix,
    network: `${prefix}-net`,
    egressNetwork: `${prefix}-egress`,
    container: (role: Role) => `${prefix}-${role}`,
  };
}

export function assertPythonResourceLabels(
  labels: Labels | undefined,
  projectId: string,
  role: string,
) {
  const { key } = pythonStackIdentity(projectId);
  if (
    labels?.[OWNER] !== VERSION ||
    labels?.[`${OWNER}.project`] !== key ||
    labels?.[`${OWNER}.role`] !== role
  )
    throw new Error("Python runtime resource identity mismatch; refusing to modify it.");
}

function backendDirectory(projectDir: string): string | null {
  for (const relative of ["server", "backend", ""]) {
    const directory = path.resolve(projectDir, relative);
    try {
      if (fs.lstatSync(directory).isSymbolicLink()) continue;
      const requirements = path.join(directory, "requirements.txt");
      const main = path.join(directory, "app", "main.py");
      if (
        fs.lstatSync(requirements).isFile() &&
        !fs.lstatSync(requirements).isSymbolicLink() &&
        fs.lstatSync(main).isFile() &&
        !fs.lstatSync(main).isSymbolicLink() &&
        /\bfastapi\b/i.test(fs.readFileSync(requirements, "utf8"))
      )
        return directory;
    } catch {
      /* Not a supported backend layout. */
    }
  }
  return null;
}

export function detectPythonStack(projectDir: string): boolean {
  return backendDirectory(projectDir) !== null;
}

function labelArgs(projectId: string, role: string): string[] {
  return [
    "--label",
    `${OWNER}=${VERSION}`,
    "--label",
    `${OWNER}.project=${pythonStackIdentity(projectId).key}`,
    "--label",
    `${OWNER}.role=${role}`,
  ];
}

async function inspect(
  kind: "container" | "network" | "volume",
  name: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  // A failed inspect must not be interpreted as absence (daemon/permission failures).
  const args =
    kind === "container"
      ? ["ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]
      : [
          kind,
          "ls",
          "--filter",
          `name=^${name}$`,
          "--format",
          kind === "volume" ? "{{.Name}}" : "{{.Name}}",
        ];
  const names = (await dependencyDocker(args, signal, 30_000))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (!names.includes(name)) return null;
  const result = JSON.parse(await dependencyDocker([kind, "inspect", name], signal, 30_000));
  if (!Array.isArray(result) || result.length !== 1)
    throw new Error("Invalid Python runtime resource inspection.");
  return result[0];
}

async function owned(
  kind: "container" | "network" | "volume",
  name: string,
  projectId: string,
  role: string,
  signal?: AbortSignal,
) {
  const resource = await inspect(kind, name, signal);
  if (resource) {
    const labels =
      kind === "container"
        ? (resource.Config as { Labels?: Labels })?.Labels
        : (resource.Labels as Labels);
    assertPythonResourceLabels(labels, projectId, role);
  }
  return resource;
}

/** Safe after platform restart: exact names AND all ownership labels, no volume deletion. */
export async function stopPythonStack(projectId: string): Promise<void> {
  const id = pythonStackIdentity(projectId);
  let failed = false;
  try {
    await (await import("./python-model-relay")).stopPythonModelRelay(projectId);
  } catch {
    failed = true;
  }
  for (const role of [...ROLES].reverse()) {
    try {
      const resource = await owned("container", id.container(role), projectId, role);
      if (resource) {
        await dependencyDocker(["rm", "--force", String(resource.Id)], undefined, 60_000);
        if (await inspect("container", id.container(role)))
          throw new Error("Container removal unconfirmed.");
      }
    } catch {
      failed = true;
    }
  }
  if (failed)
    throw new Error(
      "Python runtime cleanup could not be confirmed; unrelated resources were not touched.",
    );
}

async function privateDirectory(directory: string) {
  // Walk every component, including platform state parents: never follow a project-provided symlink.
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await fsp.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fsp.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe Python runtime state directory.");
  }
  await fsp.chmod(absolute, 0o700);
}

async function privateFile(file: string, value: string, exclusive = false) {
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("Unsafe Python runtime state file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fsp.writeFile(file, value, { mode: 0o600, flag: exclusive ? "wx" : "w" });
  await fsp.chmod(file, 0o600);
}

/** Persisted only in platform state; never returned in status, logs, or Docker argv. */
export async function ensurePythonRuntimeSecrets(
  directory: string,
  projectId: string,
): Promise<void> {
  await privateDirectory(directory);
  const file = path.join(directory, "app.env");
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384)
      throw new Error("Unsafe Python runtime credentials.");
    const data = await fsp.readFile(file, "utf8");
    if (
      !/^SECRET_KEY=[a-f0-9]{64}$/m.test(data) ||
      !/^INITIAL_ADMIN_PASSWORD=[a-f0-9]{48}$/m.test(data) ||
      !data.includes(
        `@${pythonStackIdentity(projectId).container("mysql")}:3306/app?charset=utf8mb4`,
      )
    )
      throw new Error(
        "Invalid Python runtime credentials; refusing regeneration against existing data.",
      );
    await fsp.chmod(file, 0o600);
    const db = await fsp.lstat(path.join(directory, "mysql.env"));
    if (!db.isFile() || db.isSymbolicLink() || db.nlink !== 1)
      throw new Error("Unsafe Python runtime database credentials.");
    await fsp.chmod(path.join(directory, "mysql.env"), 0o600);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Refuse half-written credentials, rather than silently changing an existing database password.
  if (fs.existsSync(file) || fs.existsSync(path.join(directory, "mysql.env")))
    throw new Error("Incomplete Python runtime credentials require platform recovery.");
  const password = randomBytes(24).toString("hex");
  const rootPassword = randomBytes(32).toString("hex");
  const id = pythonStackIdentity(projectId);
  await privateFile(
    path.join(directory, "mysql.env"),
    `MYSQL_DATABASE=app\nMYSQL_USER=app\nMYSQL_PASSWORD=${password}\nMYSQL_ROOT_PASSWORD=${rootPassword}\n`,
    true,
  );
  await privateFile(
    file,
    [
      "APP_ENV=development",
      "DEBUG=false",
      `SECRET_KEY=${randomBytes(32).toString("hex")}`,
      `DATABASE_URL=mysql+pymysql://app:${password}@${id.container("mysql")}:3306/app?charset=utf8mb4`,
      `REDIS_URL=redis://${id.container("redis")}:6379/0`,
      `CELERY_BROKER_URL=redis://${id.container("redis")}:6379/1`,
      `CELERY_RESULT_BACKEND=redis://${id.container("redis")}:6379/2`,
      "INITIAL_ADMIN_USERNAME=admin",
      `INITIAL_ADMIN_PASSWORD=${randomBytes(24).toString("hex")}`,
      "UPLOAD_DIR=/data/uploads",
      "EXPORT_DIR=/data/exports",
      "PYTHONDONTWRITEBYTECODE=1",
      "PYTHONUNBUFFERED=1",
      "HOME=/tmp",
      "LOG_LEVEL=WARNING",
      "CORS_ORIGINS=http://localhost:4311,http://127.0.0.1:4311",
      "",
    ].join("\n"),
    true,
  );
}

/** Sensitive opt-in read: caller MUST authenticate and authorize project ownership first.
 * Never include this in runtime status, diagnostics, telemetry, or logs.
 */
export async function readPythonPreviewLogin(
  projectId: string,
): Promise<{ username: string; password: string }> {
  const id = pythonStackIdentity(projectId);
  const directory = path.resolve(process.cwd(), ".agent-state", id.key, "runtime");
  // Validate every directory before opening the credential file; do not create or regenerate it.
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe Python runtime credential path.");
  }
  const file = path.join(directory, "app.env");
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_384)
    throw new Error("Unsafe Python runtime credential file.");
  const text = await fsp.readFile(file, "utf8");
  if (!text.includes(`@${id.container("mysql")}:3306/app?charset=utf8mb4`))
    throw new Error("Python runtime credential project mismatch.");
  const password = /^INITIAL_ADMIN_PASSWORD=([a-f0-9]{48})$/m.exec(text)?.[1];
  if (!password || !/^INITIAL_ADMIN_USERNAME=admin$/m.test(text))
    throw new Error("Invalid Python runtime preview credentials.");
  return { username: "admin", password };
}

async function imageId(tag: string, pull: boolean, signal: AbortSignal): Promise<string> {
  const images = await dependencyDocker(
    ["image", "ls", "--quiet", "--no-trunc", tag],
    signal,
    30_000,
  );
  if (!images.trim() && pull) await dependencyDocker(["pull", tag], signal, 600_000);
  const info = JSON.parse(await dependencyDocker(["image", "inspect", tag], signal, 30_000))[0];
  if (info?.Os !== "linux" || !/^sha256:[a-f0-9]{64}$/.test(info?.Id))
    throw new Error("Pinned Python runtime Linux image unavailable.");
  return info.Id as string;
}

export function pythonRequirementsHash(requirements: string[], image: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        requirements: [...requirements].sort(),
        image,
        index: "https://pypi.org/simple",
        binaryOnly: true,
        version: 1,
      }),
    )
    .digest("hex");
}

const INSTALL = String.raw`
import os, subprocess, sys
subprocess.run(['python3','-m','venv','/tmp/venv'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
py='/tmp/venv/bin/python'
subprocess.run([py,'-m','pip','--isolated','install','--no-index','--only-binary=:all:','--find-links','/wheels','--disable-pip-version-check','-r','/input/requirements.txt'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
os.environ['PATH']='/tmp/venv/bin:'+os.environ.get('PATH','')
`;
const BOOTSTRAP_BODY = String.raw`
import os, subprocess, time
py='/tmp/venv/bin/python'
from sqlalchemy import create_engine, inspect
engine=create_engine(os.environ['DATABASE_URL'])
for attempt in range(120):
 try:
  with engine.connect() as conn:
   tables=inspect(conn).get_table_names()
  break
 except Exception:
  if attempt==119: raise RuntimeError('Database readiness timed out') from None
  time.sleep(1)
# Only a brand-new, empty project database may be migrated/seeded automatically.
if not tables:
 subprocess.run(['/tmp/venv/bin/alembic','upgrade','head'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run([py,'-m','app.db.seed'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
elif 'alembic_version' not in tables:
 raise RuntimeError('Refusing migration of an existing unrecognized database')
from alembic.config import Config
from alembic.script import ScriptDirectory
from alembic.runtime.migration import MigrationContext
with engine.connect() as conn:
 current=set(MigrationContext.configure(conn).get_current_heads())
expected=set(ScriptDirectory.from_config(Config('alembic.ini')).get_heads())
if not expected or current != expected:
 raise RuntimeError('Existing project database schema is not at the bundled migration head')
`;
const BOOTSTRAP = INSTALL + `\nos.execv(py, [py, '-c', ${JSON.stringify(BOOTSTRAP_BODY)}])\n`;
const DOWNLOAD = String.raw`
import subprocess, sys, pathlib
subprocess.run(['python3','-m','venv','/tmp/fetch'],check=True)
subprocess.run(['/tmp/fetch/bin/python','-m','pip','--isolated','download','--disable-pip-version-check','--no-cache-dir','--only-binary=:all:','--dest','/wheels','--proxy',sys.argv[1],'--index-url','https://pypi.org/simple','-r','/input/requirements.txt'],check=True)
`;

// Audited source-only snapshot: no environment file (including examples) is ever opened.
export async function snapshotPythonSource(root: string, destination: string): Promise<void> {
  let count = 0;
  let bytes = 0;
  await fsp.mkdir(destination, { recursive: true });
  async function walk(directory: string, depth: number) {
    if (depth > 24 || ++count > 10_000)
      throw new Error("Python runtime source tree exceeds safety limit.");
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (++count > 10_000) throw new Error("Python runtime source tree exceeds safety limit.");
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink())
        throw new Error("Symlink Python source trees are not supported by the runtime.");
      if (
        /^(?:\.env.*|auth\.json|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx|sqlite|sqlite3|db))$/i.test(
          entry.name,
        ) ||
        [
          ".git",
          "node_modules",
          ".venv",
          "venv",
          "__pycache__",
          ".pytest_cache",
          "var",
          "uploads",
          "exports",
          ".agent-state",
        ].includes(entry.name)
      )
        continue;
      const target = path.join(destination, relative);
      if (entry.isDirectory()) {
        await fsp.mkdir(target, { recursive: true });
        await walk(absolute, depth + 1);
      } else if (entry.isFile()) {
        const handle = await fsp.open(
          absolute,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.nlink !== 1)
            throw new Error("Unsafe linked Python source file.");
          bytes += stat.size;
          if (stat.size > 8 * 1024 * 1024 || bytes > 64 * 1024 * 1024)
            throw new Error("Python runtime source exceeds copy limit.");
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, await handle.readFile(), { flag: "wx" });
        } finally {
          await handle.close();
        }
      } else throw new Error("Unsupported Python runtime source file.");
    }
  }
  await walk(root, 0);
}

export interface PythonStackOptions {
  projectId: string;
  projectDir: string;
  port: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}
export interface PythonStackHandle {
  target: string;
  stop: () => Promise<void>;
  assertHealthy: () => Promise<void>;
}

export async function startPythonStack(options: PythonStackOptions): Promise<PythonStackHandle> {
  const { projectId, projectDir, port, log } = options;
  const id = pythonStackIdentity(projectId);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid Python runtime port.");
  if (active.has(id.key)) throw new Error("Python runtime operation already in progress.");
  const directory = backendDirectory(projectDir);
  if (!directory) throw new Error("Supported FastAPI backend not detected.");
  if ([directory, process.cwd()].some((value) => value.includes(",")))
    throw new Error("Unsupported runtime mount path.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, 20 * 60_000);
  const signal = controller.signal;
  active.add(id.key);
  let cleanupOwned = false;
  let stage = "identity";
  try {
    signal.throwIfAborted();
    // Refuse identity collisions before stopping or creating anything.
    for (const role of ROLES) await owned("container", id.container(role), projectId, role, signal);
    await stopPythonStack(projectId);
    cleanupOwned = true;
    stage = "state-and-source";
    const state = path.resolve(process.cwd(), ".agent-state", id.key, "runtime");
    const existingDatabase = await owned(
      "volume",
      `${id.prefix}-mysql`,
      projectId,
      "mysql",
      signal,
    );
    if (
      existingDatabase &&
      (!fs.existsSync(path.join(state, "app.env")) || !fs.existsSync(path.join(state, "mysql.env")))
    )
      throw new Error("Existing Python database requires its original runtime credentials.");
    await ensurePythonRuntimeSecrets(state, projectId);
    const source = path.join(state, `source-${randomBytes(12).toString("hex")}`);
    await snapshotPythonSource(directory, source);
    const requirements = await collectCodexPythonRequirements(source);
    const workerImage = await imageId(WORKER_IMAGE, false, signal);
    const mysqlImage = await imageId("mysql:8.0", true, signal);
    const redisImage = await imageId("redis:7-alpine", true, signal);
    const hash = pythonRequirementsHash(requirements, workerImage);
    const reqFile = path.join(state, `requirements-${hash}.txt`);
    await privateFile(reqFile, requirements.join("\n") + "\n");
    // Input contains only validated package specifications and is readable by uid 10001.
    await fsp.chmod(reqFile, 0o644);
    const volumes = {
      mysql: `${id.prefix}-mysql`,
      redis: `${id.prefix}-redis`,
      data: `${id.prefix}-data`,
      wheels: `${id.prefix}-wheels-${hash.slice(0, 24)}`,
    };
    for (const [role, name] of Object.entries(volumes)) {
      if (
        !(await owned(
          "volume",
          name,
          projectId,
          role === "wheels" ? `wheels-${hash}` : role,
          signal,
        ))
      )
        await dependencyDocker(
          [
            "volume",
            "create",
            ...labelArgs(projectId, role === "wheels" ? `wheels-${hash}` : role),
            name,
          ],
          signal,
          30_000,
        );
    }
    const network = await owned("network", id.network, projectId, "network", signal);
    if (network && network.Internal !== true)
      throw new Error("Python runtime network must be internal.");
    if (!network)
      await dependencyDocker(
        ["network", "create", "--internal", ...labelArgs(projectId, "network"), id.network],
        signal,
        30_000,
      );
    // Business applications are explicitly allowed general outbound access, including
    // local/private model endpoints. Keep database/cache on their original internal
    // data network; this is not the offline Codex execution-worker network policy.
    const egress = await owned("network", id.egressNetwork, projectId, "egress-network", signal);
    if (egress && (egress.Internal !== false || egress.Driver !== "bridge"))
      throw new Error("Python runtime egress network must be a non-internal bridge.");
    if (!egress) {
      await dependencyDocker(
        [
          "network",
          "create",
          "--driver",
          "bridge",
          ...labelArgs(projectId, "egress-network"),
          id.egressNetwork,
        ],
        signal,
        30_000,
      );
      const created = await owned("network", id.egressNetwork, projectId, "egress-network", signal);
      if (!created || created.Internal !== false || created.Driver !== "bridge")
        throw new Error("Python runtime egress network creation could not be verified.");
    }
    const connectEgress = (role: "bootstrap" | "backend" | "worker" | "beat") =>
      dependencyDocker(
        ["network", "connect", id.egressNetwork, id.container(role)],
        signal,
        30_000,
      );
    const base = (role: Role, net = id.network) => [
      "create",
      "--pull",
      "never",
      "--name",
      id.container(role),
      ...labelArgs(projectId, role),
      "--network",
      net,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "1g",
      "--cpus",
      "2",
      "--log-driver",
      "none",
    ];
    const remove = async (role: Role) => {
      const resource = await owned("container", id.container(role), projectId, role);
      if (resource)
        await dependencyDocker(["rm", "--force", String(resource.Id)], undefined, 60_000);
    };
    stage = "storage-permissions";
    try {
      await dependencyDocker(
        [
          ...base("prepare", "none"),
          "--user",
          "0:0",
          "--cap-add",
          "CHOWN",
          "--cap-add",
          "FOWNER",
          "--cap-add",
          "DAC_OVERRIDE",
          "--read-only",
          "--mount",
          `type=volume,src=${volumes.data},dst=/data`,
          "--mount",
          `type=volume,src=${volumes.wheels},dst=/wheels`,
          "--entrypoint",
          "python3",
          workerImage,
          "-c",
          "import os; os.makedirs('/data/uploads',exist_ok=True); os.makedirs('/data/exports',exist_ok=True); [(os.chown(p,10001,10001),os.chmod(p,0o770)) for p in ['/data','/data/uploads','/data/exports','/wheels']]",
        ],
        signal,
        30_000,
      );
      await dependencyDocker(["start", "--attach", id.container("prepare")], signal, 60_000);
      const prepared = await owned(
        "container",
        id.container("prepare"),
        projectId,
        "prepare",
        signal,
      );
      if ((prepared?.State as { ExitCode?: number })?.ExitCode !== 0)
        throw new Error("Runtime storage initialization failed.");
    } finally {
      await remove("prepare");
    }
    const marker = path.join(state, `wheels-${hash}.ready`);
    let cacheReady = false;
    try {
      const stat = await fsp.lstat(marker);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== hash.length)
        throw new Error("Unsafe Python runtime wheel cache marker.");
      cacheReady = (await fsp.readFile(marker, "utf8")) === hash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!cacheReady) {
      log?.("Downloading validated Python wheels through the restricted dependency proxy.");
      stage = "wheel-download";
      await withDependencyNetwork(async ({ networkName, proxyUrl, imageId: downloadImage }) => {
        stage = "wheel-container-create";
        if (downloadImage !== workerImage)
          throw new Error("Worker image changed during dependency preparation.");
        try {
          await dependencyDocker(
            [
              ...base("download", networkName),
              "--read-only",
              "--tmpfs",
              "/tmp:rw,exec,nosuid,nodev,size=768m,mode=1777",
              "--mount",
              `type=volume,src=${volumes.wheels},dst=/wheels`,
              "--mount",
              `type=bind,src=${reqFile},dst=/input/requirements.txt,readonly`,
              "--entrypoint",
              "python3",
              workerImage,
              "-c",
              DOWNLOAD,
              proxyUrl,
            ],
            signal,
            30_000,
          );
          stage = "wheel-download-process";
          await dependencyDocker(["start", "--attach", id.container("download")], signal, 600_000);
          const info = await owned(
            "container",
            id.container("download"),
            projectId,
            "download",
            signal,
          );
          if ((info?.State as { ExitCode?: number })?.ExitCode !== 0)
            throw new Error("Wheel download failed.");
        } finally {
          await remove("download");
        }
      }, signal);
      await privateFile(marker, hash);
    }
    stage = "database-service-create";
    // Official entrypoints need their normal initialization capabilities; applications never do.
    const dbBase = (role: "mysql" | "redis") => [
      "create",
      "--pull",
      "never",
      "--name",
      id.container(role),
      ...labelArgs(projectId, role),
      "--network",
      id.network,
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "1g",
      "--log-driver",
      "none",
    ];
    await dependencyDocker(
      [
        ...dbBase("mysql"),
        "--env-file",
        path.join(state, "mysql.env"),
        "--mount",
        `type=volume,src=${volumes.mysql},dst=/var/lib/mysql`,
        mysqlImage,
      ],
      signal,
      30_000,
    );
    await dependencyDocker(
      [
        ...dbBase("redis"),
        "--mount",
        `type=volume,src=${volumes.redis},dst=/data`,
        redisImage,
        "redis-server",
        "--appendonly",
        "yes",
      ],
      signal,
      30_000,
    );
    await dependencyDocker(["start", id.container("mysql"), id.container("redis")], signal, 60_000);
    const appArgs = (role: "bootstrap" | "backend" | "worker" | "beat") => [
      ...base(role),
      "--add-host",
      "host.docker.internal:host-gateway",
      "--env",
      "MODEL_ENDPOINT_HOST_ALIAS=host.docker.internal",
      "--read-only",
      "--user",
      "10001:10001",
      "--tmpfs",
      "/tmp:rw,exec,nosuid,nodev,size=768m,mode=1777",
      "--env-file",
      path.join(state, "app.env"),
      "--workdir",
      "/source",
      "--mount",
      `type=bind,src=${source},dst=/source,readonly`,
      "--mount",
      `type=bind,src=${reqFile},dst=/input/requirements.txt,readonly`,
      "--mount",
      `type=volume,src=${volumes.wheels},dst=/wheels,readonly`,
      "--mount",
      `type=volume,src=${volumes.data},dst=/data`,
    ];
    stage = "database-bootstrap";
    log?.("Initializing the isolated project database and bundled administrator when empty.");
    try {
      await dependencyDocker(
        [...appArgs("bootstrap"), "--entrypoint", "python3", workerImage, "-c", BOOTSTRAP],
        signal,
        30_000,
      );
      await connectEgress("bootstrap");
      await dependencyDocker(["start", "--attach", id.container("bootstrap")], signal, 240_000);
      const result = await owned(
        "container",
        id.container("bootstrap"),
        projectId,
        "bootstrap",
        signal,
      );
      if ((result?.State as { ExitCode?: number })?.ExitCode !== 0)
        throw new Error("Project database bootstrap failed.");
    } finally {
      await remove("bootstrap");
    }
    stage = "application-create";
    for (const role of ["backend", "worker", "beat"] as const) {
      const command =
        role === "backend"
          ? [
              "/tmp/venv/bin/python",
              "-m",
              "uvicorn",
              "app.main:create_app",
              "--factory",
              "--host",
              "0.0.0.0",
              "--port",
              "8000",
            ]
          : [
              "/tmp/venv/bin/celery",
              "-A",
              "app.tasks.celery_app:celery_app",
              role === "worker" ? "worker" : "beat",
              ...(role === "worker"
                ? ["--concurrency=2", "--loglevel=WARNING"]
                : [
                    "--schedule=/data/celerybeat-schedule",
                    "--pidfile=/tmp/celerybeat.pid",
                    "--loglevel=WARNING",
                  ]),
            ];
      const script =
        INSTALL + `\nos.execv(${JSON.stringify(command[0])}, ${JSON.stringify(command)})\n`;
      await dependencyDocker(
        [...appArgs(role), "--entrypoint", "python3", workerImage, "-c", script],
        signal,
        30_000,
      );
      await connectEgress(role);
      await dependencyDocker(["start", id.container(role)], signal, 30_000);
    }
    stage = "authorized-model-relay";
    await (await import("./python-model-relay")).ensurePythonModelRelay(projectId, signal);
    stage = "loopback-ingress";
    // Keep preview ingress on loopback, without source/credential mounts. Business
    // applications have their own project egress bridge; database/cache remain internal.
    const relay = `const net=require('net'); const host=${JSON.stringify(id.container("backend"))}; net.createServer(a=>{const b=net.connect(8000,host);a.pipe(b);b.pipe(a);a.on('error',()=>b.destroy());b.on('error',()=>a.destroy());a.on('close',()=>b.destroy());b.on('close',()=>a.destroy());}).listen(8000,'0.0.0.0');`;
    await dependencyDocker(
      [
        ...base("ingress", "bridge"),
        "--user",
        "10001:10001",
        "--read-only",
        "--publish",
        `127.0.0.1:${port}:8000`,
        "--entrypoint",
        "node",
        workerImage,
        "-e",
        relay,
      ],
      signal,
      30_000,
    );
    await dependencyDocker(
      ["network", "connect", id.network, id.container("ingress")],
      signal,
      30_000,
    );
    await dependencyDocker(["start", id.container("ingress")], signal, 30_000);
    const target = `http://127.0.0.1:${port}`;
    const checkHealth = async () => {
      for (const role of ["mysql", "redis", "backend", "worker", "beat", "ingress"] as const) {
        const resource = await owned("container", id.container(role), projectId, role);
        if (!(resource?.State as { Running?: boolean })?.Running)
          throw new Error("Python runtime service is not running.");
      }
      const response = await fetch(`${target}/api/health/ready`, {
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Python runtime HTTP health check failed.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty Python runtime health response.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 32_768) throw new Error("Invalid Python runtime health response.");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const report = JSON.parse(text) as {
        status?: string;
        checks?: { name?: string; status?: string; extra?: { workers?: unknown[] } }[];
      };
      if (
        report.status !== "ok" ||
        !["database", "cache", "queue"].every((name) =>
          report.checks?.some((check) => check.name === name && check.status === "ok"),
        ) ||
        !report.checks?.some(
          (check) =>
            check.name === "queue" &&
            check.status === "ok" &&
            Array.isArray(check.extra?.workers) &&
            check.extra.workers.length > 0,
        )
      )
        throw new Error("Python runtime queue worker is not ready.");
    };
    const assertHealthy = async () => {
      try {
        await checkHealth();
      } catch {
        // Docker/HTTP JSON and fetch errors may contain arbitrary project-controlled text.
        throw new Error("Python runtime health verification failed.");
      }
    };
    stage = "application-readiness";
    const deadline = Date.now() + 120_000;
    while (true) {
      signal.throwIfAborted();
      try {
        await assertHealthy();
        break;
      } catch {
        if (Date.now() >= deadline)
          throw new Error("Python runtime did not become healthy in time.");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    log?.("Isolated Python backend, MySQL, Redis, Celery worker and beat are ready.");
    return { target, stop: () => stopPythonStack(projectId), assertHealthy };
  } catch {
    let cleanupFailed = false;
    if (cleanupOwned)
      try {
        await stopPythonStack(projectId);
      } catch {
        cleanupFailed = true;
      }
    throw new Error(
      cleanupFailed
        ? "Python runtime failed; owned container cleanup requires attention."
        : options.signal?.aborted
          ? "Python runtime startup cancelled."
          : `Python runtime startup failed at ${stage}. No credentials or project command output are exposed.`,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    active.delete(id.key);
  }
}
