import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withDependencyNetwork } from "./codex-dependency-network";

const IMAGE = "gs-codex-worker:0.150.1";
export const CODEX_DEPENDENCY_TIMEOUT_MS = 600_000;
const ROOTS = ["", "client", "backend", "server"] as const;
type Status = "passed" | "blocked" | "failed";
export interface CodexDependencyReport {
  status: Status;
  reason: string;
  roots: Array<{
    root: string;
    status: Status;
    installed: boolean;
    reason: string;
    lockfileGenerated?: boolean;
  }>;
  isolation: "docker-network-none-offline-cache" | "docker-internal-network-controlled-proxy";
  scripts: "skipped";
  lockfileGenerated?: boolean;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid JSON object.");
  return value as Record<string, unknown>;
}
function declarations(value: Record<string, unknown>) {
  for (const group of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    if (value[group] === undefined) continue;
    for (const [name, spec] of Object.entries(object(value[group]))) {
      if (
        !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
        name === "." ||
        name === ".." ||
        typeof spec !== "string" ||
        !spec.trim() ||
        !/^[a-z0-9*^~<>=| .+_-]+$/i.test(spec)
      )
        throw new Error(
          "Only registry version/range dependencies are supported (no file/git/URL/alias dependencies).",
        );
    }
  }
  if (value.workspaces !== undefined || value.overrides !== undefined)
    throw new Error("Workspaces/overrides require a separately reviewed provisioning policy.");
}
/** Manifest-only policy check: registry version ranges, no workspace/alias tricks. */
export function validateCodexDependencyManifest(manifest: unknown): void {
  declarations(object(manifest));
}
/** Conservative npm lock v2/v3 policy; no evaluation of project code or npm configuration. */
export function validateCodexDependencyLock(manifest: unknown, lockfile: unknown): void {
  validateCodexDependencyManifest(manifest);
  const lock = object(lockfile);
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3)
    throw new Error("A package-lock.json version 2 or 3 is required.");
  const packages = object(lock.packages);
  if (!("" in packages)) throw new Error("Lockfile root package is missing.");
  for (const [location, raw] of Object.entries(packages)) {
    const entry = object(raw);
    declarations(entry);
    if (location === "") continue;
    if (
      !/^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/)*node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(
        location,
      ) ||
      location.split("/").some((part) => part === "." || part === "..") ||
      entry.link
    )
      throw new Error("Lockfile contains an unsupported package location/link.");
    if (typeof entry.resolved !== "string" || typeof entry.integrity !== "string")
      throw new Error("Every locked package must have a registry URL and integrity.");
    const url = new URL(entry.resolved);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "registry.npmjs.org" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith(".tgz")
    )
      throw new Error("Only HTTPS registry.npmjs.org tarballs are permitted.");
    if (!/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity))
      throw new Error("A strong package integrity digest is required.");
  }
  // npm v2's legacy tree can override metadata: refuse conflicting/unsafe entries too.
  function legacy(raw: unknown) {
    for (const item of Object.values(object(raw))) {
      const entry = object(item);
      if (typeof entry.version !== "string" || !/^[0-9][a-z0-9.+_-]*$/i.test(entry.version))
        throw new Error("Unsupported legacy lockfile dependency.");
      if (entry.resolved !== undefined) {
        const matching = Object.values(packages).some((pkg) => {
          const p = object(pkg);
          return p.resolved === entry.resolved && p.integrity === entry.integrity;
        });
        if (!matching) throw new Error("Unverified legacy lockfile dependency.");
      }
      if (entry.dependencies !== undefined) legacy(entry.dependencies);
    }
  }
  if (lock.dependencies !== undefined) legacy(lock.dependencies);
}

async function json(file: string) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 8 * 1024 * 1024)
    throw new Error("Manifest/lockfile must be a bounded regular file.");
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}
async function directory(target: string) {
  // Reject symlink ancestors, including junctions, before any host bind mount.
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink())
      throw new Error("Symlink paths are not allowed.");
  }
  if (!(await fs.stat(target)).isDirectory() || /[,\r\n\0]/.test(target))
    throw new Error("Invalid bind directory.");
}

// This constant is platform-owned code, never generated/project code. No shell, lifecycle,
// project .npmrc, NODE_OPTIONS, model credential, Docker socket or gateway is inherited.
const BOOTSTRAP = String.raw`
const fs = require('node:fs/promises');
const {spawn} = require('node:child_process');
(async () => {
  await fs.mkdir('/tmp/project', {recursive:true});
  // Distinct empty config files: npm refuses to load one path as both user and global config.
  await fs.writeFile('/tmp/npmrc-user',''); await fs.writeFile('/tmp/npmrc-global','');
  for (const name of ['package.json','package-lock.json'])
    await fs.copyFile('/input/' + name, '/tmp/project/' + name);
  await fs.cp('/cache/_cacache', '/tmp/cache/_cacache', {recursive:true});
  const args = ['ci','--ignore-scripts','--offline','--cache=/tmp/cache',
    '--registry=https://registry.npmjs.org','--include=dev','--no-audit','--no-fund',
    '--update-notifier=false','--loglevel=error','--userconfig=/tmp/npmrc-user','--globalconfig=/tmp/npmrc-global'];
  const child = spawn('/usr/local/bin/npm', args, {cwd:'/tmp/project', stdio:'ignore',
    env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp/home',CI:'true'}});
  const code = await new Promise((resolve,reject) => { child.once('error',reject); child.once('close',resolve); });
  if (code !== 0) process.exit(1);
  await fs.mkdir('/tmp/project/node_modules', {recursive:true});
  for (const name of await fs.readdir('/tmp/project/node_modules'))
    await fs.cp('/tmp/project/node_modules/' + name, '/output/' + name, {recursive:true, dereference:false, verbatimSymlinks:true});
})().catch(() => process.exit(1));
`;

// Controlled-network bootstrap: the only place npm may reach a registry. It runs
// in a disposable container with no project code, no project .npmrc, no lifecycle
// scripts and no credential; egress is a TLS-CONNECT proxy limited to the npm
// registry. A missing lockfile is generated here for THIS COPY ONLY.
const NETWORK_BOOTSTRAP = String.raw`
const fs = require('node:fs/promises');
const {spawn} = require('node:child_process');
const run = (args) => new Promise((resolve,reject) => {
  const child = spawn('/usr/local/bin/npm', args, {cwd:'/tmp/project', stdio:'inherit',
    env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp/home',CI:'true'}});
  child.once('error', reject); child.once('close', resolve);
});
(async () => {
  await fs.mkdir('/tmp/project', {recursive:true});
  // Distinct empty config files: npm refuses to load one path as both user and global config.
  await fs.writeFile('/tmp/npmrc-user',''); await fs.writeFile('/tmp/npmrc-global','');
  await fs.copyFile('/input/package.json', '/tmp/project/package.json');
  let locked = false;
  try { await fs.copyFile('/input/package-lock.json', '/tmp/project/package-lock.json'); locked = true; } catch {}
  const base = ['--ignore-scripts','--no-audit','--no-fund','--update-notifier=false',
    '--loglevel=error','--userconfig=/tmp/npmrc-user','--globalconfig=/tmp/npmrc-global',
    '--registry=https://registry.npmjs.org','--cache=/tmp/npm-cache','--include=dev'];
  // npm ignores proxy environment variables here, so pass the restricted proxy explicitly.
  const proxy = process.argv[1] || '';
  if (proxy) base.push('--proxy=' + proxy, '--https-proxy=' + proxy);
  if (!locked) {
    if (await run(['install','--package-lock-only',...base]) !== 0) process.exit(2);
  }
  if (await run(['ci',...base]) !== 0) process.exit(3);
  await fs.mkdir('/tmp/project/node_modules', {recursive:true});
  for (const name of await fs.readdir('/tmp/project/node_modules'))
    await fs.cp('/tmp/project/node_modules/' + name, '/output/' + name, {recursive:true, dereference:false, verbatimSymlinks:true});
  if (!locked) await fs.copyFile('/tmp/project/package-lock.json', '/generated/package-lock.json');
})().catch(() => process.exit(1));
`;

function docker(
  args: string[],
  signal?: AbortSignal,
  timeoutMs = CODEX_DEPENDENCY_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Dependency preparation cancelled."));
      return;
    }
    const child = spawn("docker", args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let stopped = false;
    child.stdout.on("data", (chunk) => {
      output = (output + String(chunk)).slice(0, 65536);
    });
    child.stderr.resume();
    const stop = () => {
      stopped = true;
      child.kill();
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (error || stopped)
        reject(new Error("Isolated dependency Docker operation failed/cancelled/timed out."));
      else resolve(output.trim());
    };
    child.once("error", () => finish(new Error("Docker unavailable.")));
    child.once("close", (code) =>
      finish(code === 0 ? undefined : new Error("Docker operation failed.")),
    );
  });
}

/** Caller must supply ONLY the disposable isolated stage, never the original project. */
export async function prepareCodexDependencies(
  stage: string,
  signal?: AbortSignal,
): Promise<CodexDependencyReport> {
  const report: CodexDependencyReport = {
    status: "blocked",
    reason: "No dependency installation has been verified.",
    roots: [],
    isolation: "docker-network-none-offline-cache",
    scripts: "skipped",
  };
  const roots: Array<{ root: string; directory: string; locked: boolean }> = [];
  try {
    if (signal?.aborted) throw new Error("Dependency preparation cancelled.");
    stage = path.resolve(stage);
    await directory(stage);
    for (const root of ROOTS) {
      const dir = path.join(stage, root);
      try {
        await fs.lstat(path.join(dir, "package.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await directory(dir);
      let locked = false;
      let unsafe = false;
      try {
        validateCodexDependencyLock(
          await json(path.join(dir, "package.json")),
          await json(path.join(dir, "package-lock.json")),
        );
        locked = true;
      } catch {
        // A missing lockfile can be generated in the isolated copy; an unsafe
        // manifest (file/git/URL dependency, workspaces) never can.
        try {
          validateCodexDependencyManifest(await json(path.join(dir, "package.json")));
        } catch {
          unsafe = true;
        }
      }
      if (unsafe) {
        report.roots.push({
          root,
          status: "blocked",
          installed: false,
          reason:
            "Unsupported package.json dependency declaration; only registry version ranges are supported.",
        });
        continue;
      }
      roots.push({ root, directory: dir, locked });
    }
    if (report.roots.length) {
      report.reason = "A package root has an unsupported manifest; nothing installed.";
      return report;
    }
    if (!roots.length) {
      report.reason = "No supported Node package roots found; nothing installed.";
      return report;
    }
    const cacheSetting = process.env.GS_CODEX_NPM_CACHE?.trim();
    const useCache = Boolean(cacheSetting && path.isAbsolute(cacheSetting));
    if (!useCache && roots.some((item) => !item.locked)) {
      // Lockless roots require the controlled download path below.
      report.isolation = "docker-internal-network-controlled-proxy";
    }
    if (useCache && roots.some((item) => !item.locked)) {
      const reason =
        "Missing or unsafe package-lock.json/manifest; only locked registry dependencies are supported with the offline cache.";
      report.roots = roots.map((item) => ({
        root: item.root,
        status: "blocked" as Status,
        installed: false,
        reason,
      }));
      report.reason = "A package root has no safe lockfile; nothing installed.";
      return report;
    }
    const cache = useCache ? path.resolve(cacheSetting as string) : "";
    if (useCache) {
      await directory(cache);
      await directory(path.join(cache, "_cacache"));
      if (
        cache === stage ||
        cache.startsWith(stage + path.sep) ||
        stage.startsWith(cache + path.sep)
      )
        throw new Error("Trusted cache must be separate from the stage.");
    }
    const verifyImage = async () => {
      const image = object(
        JSON.parse(
          await docker(["image", "inspect", IMAGE, "--format", "{{json .}}"], signal, 30_000),
        ),
      );
      if (
        image.Os !== "linux" ||
        typeof image.Id !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(image.Id)
      )
        throw new Error("Pinned Linux worker image unavailable.");
      return image.Id;
    };
    /** Installs one package root and records bounded, non-secret evidence. */
    const installRoot = async (
      item: { root: string; directory: string },
      imageId: string,
      online: { network: string; proxy: string } | null,
    ) => {
      const name = `gs-codex-deps-${randomUUID()}`;
      const modules = path.join(item.directory, "node_modules");
      let installed = false;
      let cleanup = false;
      let lockfileGenerated = false;
      let generatedDirectory: string | undefined;
      try {
        if (signal?.aborted) throw new Error("Dependency preparation cancelled.");
        try {
          if ((await fs.lstat(modules)).isSymbolicLink())
            throw new Error("Dependency output cannot be a symlink.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await fs.rm(modules, { recursive: true, force: true });
        await fs.mkdir(modules, { mode: 0o777 });
        await fs.chmod(modules, 0o777); // Only disposable dependency output; nonroot Linux uid writes here.
        const mounts = [`type=bind,src=${item.directory},dst=/input,readonly`];
        if (online) {
          mounts.push(`type=bind,src=${modules},dst=/output`);
          generatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gs-npm-lock-"));
          mounts.push(`type=bind,src=${generatedDirectory},dst=/generated`);
        } else {
          mounts.push(`type=bind,src=${cache},dst=/cache,readonly`);
          mounts.push(`type=bind,src=${modules},dst=/output`);
        }
        await docker(
          [
            "run",
            "--pull",
            "never",
            "--name",
            name,
            "--network",
            online ? online.network : "none",
            "--read-only",
            "--user",
            "10001:10001",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "512",
            "--memory",
            "2g",
            "--cpus",
            "2",
            "--log-driver",
            "none",
            "--tmpfs",
            // `exec` is required: Docker's --tmpfs default is noexec, which breaks
            // packages that map or execute files staged under /tmp.
            "/tmp:rw,exec,nosuid,nodev,size=1073741824,mode=1777",
            ...mounts.flatMap((mount) => ["--mount", mount]),
            "--workdir",
            "/tmp",
            "--entrypoint",
            "/usr/local/bin/node",
            imageId,
            "-e",
            online ? NETWORK_BOOTSTRAP : BOOTSTRAP,
            ...(online ? [online.proxy] : []),
          ],
          signal,
        );
        installed = true;
        if (online && generatedDirectory) {
          // A generated lockfile stays inside this disposable copy; the real project is not written.
          try {
            const candidate = path.join(generatedDirectory, "package-lock.json");
            const generated = await fs.lstat(candidate);
            if (generated.isFile() && !generated.isSymbolicLink()) {
              await fs.copyFile(
                candidate,
                path.join(item.directory, "package-lock.generated.json"),
              );
              lockfileGenerated = true;
            }
          } catch {
            lockfileGenerated = false;
          }
        }
      } catch {
        /* No daemon/package output or host paths in evidence. */
      } finally {
        if (generatedDirectory) await fs.rm(generatedDirectory, { recursive: true, force: true });
        // Killing only the Docker CLI does not stop the container. Force-remove and verify
        // independently of the caller's aborted signal before considering any success.
        try {
          await docker(["rm", "--force", name], undefined, 30_000);
          const remaining = await docker(
            ["ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"],
            undefined,
            30_000,
          );
          cleanup = !remaining;
        } catch {
          cleanup = false;
        }
        if (!installed || !cleanup || signal?.aborted) {
          installed = false;
          await fs.rm(modules, { recursive: true, force: true });
        }
      }
      report.roots.push({
        root: item.root,
        status: installed ? "passed" : "failed",
        installed,
        lockfileGenerated: lockfileGenerated || undefined,
        reason: installed
          ? online
            ? lockfileGenerated
              ? "Registry install completed with scripts skipped; this copy generated a lockfile. Container removal verified."
              : "Registry install completed with scripts skipped; container removal verified."
            : "Offline npm ci completed with scripts skipped; container removal verified."
          : online
            ? "Registry installation or container cleanup failed/cancelled/timed out; no verified install."
            : "Offline installation or container cleanup failed/cancelled/timed out; no verified install.",
      });
      return installed;
    };
    if (useCache) {
      const imageId = await verifyImage();
      for (const item of roots) if (!(await installRoot(item, imageId, null))) break;
    } else {
      report.isolation = "docker-internal-network-controlled-proxy";
      await withDependencyNetwork(async ({ networkName, proxyUrl, imageId }) => {
        for (const item of roots)
          if (!(await installRoot(item, imageId, { network: networkName, proxy: proxyUrl }))) break;
      }, signal);
    }
    report.lockfileGenerated = report.roots.some((root) => root.lockfileGenerated);
    report.status =
      report.roots.length === roots.length && report.roots.every((r) => r.installed)
        ? "passed"
        : "failed";
    report.reason =
      report.status === "passed"
        ? report.isolation === "docker-internal-network-controlled-proxy"
          ? report.lockfileGenerated
            ? "All discovered package roots installed through the controlled dependency proxy; a lockfile was generated for this copy only. Not build/test evidence."
            : "All discovered package roots installed through the controlled dependency proxy; not build/test evidence."
          : "All discovered package roots installed offline; not build/test evidence."
        : "Dependency preparation failed; do not claim build/test success.";
  } catch {
    report.status = signal?.aborted ? "failed" : "blocked";
    report.reason = signal?.aborted
      ? "Dependency preparation cancelled; no verified install."
      : "Trusted offline cache, stage, or pinned worker unavailable; no host/network fallback.";
  }
  return report;
}
