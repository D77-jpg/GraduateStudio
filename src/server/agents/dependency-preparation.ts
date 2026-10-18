import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export const DEPENDENCY_INSTALL_ARGS = [
  "install",
  "--ignore-scripts",
  "--include=dev",
  "--no-audit",
  "--no-fund",
  "--loglevel=error",
] as const;
export const DEPENDENCY_INSTALL_TIMEOUT_MS = 600_000;
export const DEPENDENCY_OUTPUT_LIMIT = 16_000;

export interface LocalDependencyReadiness {
  ready: boolean;
  reason: string;
  missing: string[];
}
export interface DependencyInstallRequest {
  cwd: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
  signal?: AbortSignal;
}
export interface DependencyInstallResult {
  exitCode: number | null;
  output?: string;
  blockedReason?: string;
}
export type DependencyExecutor = (
  request: DependencyInstallRequest,
) => Promise<DependencyInstallResult>;
export interface DependencyPreparationResult {
  ready: boolean;
  output: string;
  checks: Array<LocalDependencyReadiness & { directory: string; installed: boolean }>;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

async function readManifest(file: string): Promise<Record<string, unknown>> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000)
    throw new Error("Invalid manifest");
  const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid manifest");
  return value as Record<string, unknown>;
}

function declaredDependencies(manifest: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const group of ["dependencies", "devDependencies"]) {
    const value = manifest[group];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid dependencies");
    for (const [name, spec] of Object.entries(value)) {
      if (
        !/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name) ||
        name === "." ||
        name === ".." ||
        typeof spec !== "string" ||
        !spec.trim()
      ) {
        throw new Error("Invalid dependency declaration");
      }
      names.add(name);
    }
  }
  return [...names].sort();
}

// Resolve without importing/evaluating package code. Import-only and types-only
// packages may not expose a require entry or their package.json through exports.
function alternateEntries(manifest: Record<string, unknown>): string[] {
  const entries: string[] = [];
  function visit(value: unknown): void {
    if (typeof value === "string") entries.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const map = value as Record<string, unknown>;
      for (const condition of ["node", "import", "default", "require", "types"])
        visit(map[condition]);
    }
  }
  const exports = manifest.exports;
  if (exports && typeof exports === "object" && !Array.isArray(exports) && "." in exports) {
    visit((exports as Record<string, unknown>)["."]);
  } else visit(exports);
  for (const field of ["module", "main", "types", "typings"]) {
    if (typeof manifest[field] === "string") entries.push(manifest[field] as string);
  }
  return entries;
}

/** No imports, installers, script execution, host fallbacks or external pnpm links. */
export async function checkLocalDependencies(cwd: string): Promise<LocalDependencyReadiness> {
  try {
    const root = await fs.realpath(cwd);
    const manifest = await readManifest(path.join(root, "package.json"));
    const required = declaredDependencies(manifest);
    if (!required.length) return { ready: true, reason: "No declared dependencies.", missing: [] };
    const modules = path.join(root, "node_modules");
    const localRequire = createRequire(path.join(root, "package.json"));
    const missing: string[] = [];
    async function localFile(file: string): Promise<boolean> {
      try {
        return within(modules, await fs.realpath(file)) && (await fs.stat(file)).isFile();
      } catch {
        return false;
      }
    }
    for (const name of required) {
      try {
        const packageRoot = await fs.realpath(path.join(modules, ...name.split("/")));
        if (!within(modules, packageRoot)) throw new Error("Nonlocal dependency");
        const installed = await readManifest(path.join(packageRoot, "package.json"));
        let entryReady = false;
        try {
          entryReady = await localFile(localRequire.resolve(name));
        } catch {
          /* ESM/types-only exports */
        }
        if (!entryReady) {
          for (const entry of alternateEntries(installed)) {
            if (await localFile(path.resolve(packageRoot, entry))) {
              entryReady = true;
              break;
            }
          }
        }
        // Packages exposing only binaries need no import entry.
        const bin = installed.bin;
        const binaries: Record<string, unknown> =
          typeof bin === "string"
            ? { [name.split("/").at(-1)!]: bin }
            : bin && typeof bin === "object" && !Array.isArray(bin)
              ? (bin as Record<string, unknown>)
              : {};
        const binEntries = Object.entries(binaries);
        if (!entryReady && !binEntries.length) throw new Error("Missing dependency entry");
        for (const [command, target] of binEntries) {
          if (
            !/^[a-zA-Z0-9._-]+$/.test(command) ||
            typeof target !== "string" ||
            !(await localFile(path.resolve(packageRoot, target)))
          )
            throw new Error("Missing binary target");
          const shim = path.join(
            modules,
            ".bin",
            command + (process.platform === "win32" ? ".cmd" : ""),
          );
          if (!(await localFile(shim))) throw new Error("Missing local binary shim");
        }
      } catch {
        missing.push(name);
      }
    }
    return {
      ready: missing.length === 0,
      missing,
      reason: missing.length
        ? `Local dependencies unavailable: ${missing.join(", ")}.`
        : "All declared runtime and development dependencies are local.",
    };
  } catch {
    return { ready: false, missing: [], reason: "Cannot safely read the local package manifest." };
  }
}

export function dependencyInstallEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Environment keys are case-insensitive on Windows; remove duplicate variants.
  const overrides: NodeJS.ProcessEnv = {
    NODE_ENV: "development",
    npm_config_omit: "",
    npm_config_production: "false",
    npm_config_ignore_scripts: "true",
    npm_config_include: "dev",
    CI: "true",
  };
  const keys = new Set(Object.keys(overrides).map((key) => key.toLowerCase()));
  return {
    ...Object.fromEntries(Object.entries(base).filter(([key]) => !keys.has(key.toLowerCase()))),
    ...overrides,
  };
}

export const executeDependencyInstall: DependencyExecutor = async (request) => {
  if (JSON.stringify(request.args) !== JSON.stringify(DEPENDENCY_INSTALL_ARGS))
    throw new Error("Dependency command is not allowlisted.");
  if (request.signal?.aborted)
    return { exitCode: null, blockedReason: "Dependency preparation cancelled." };
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    const child = spawn(
      windows ? "cmd.exe" : "npm",
      windows
        ? ["/d", "/s", "/c", `npm ${DEPENDENCY_INSTALL_ARGS.join(" ")}`]
        : [...DEPENDENCY_INSTALL_ARGS],
      {
        cwd: request.cwd,
        env: dependencyInstallEnvironment(request.env),
        shell: false,
        windowsHide: true,
        detached: !windows,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let bytes = 0;
    let blockedReason: string | undefined;
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    function stop(reason: string): void {
      if (blockedReason) return;
      blockedReason = reason;
      if (child.pid) {
        if (windows)
          execFile(
            "taskkill",
            ["/pid", String(child.pid), "/t", "/f"],
            { windowsHide: true },
            () => {},
          );
        else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
      // Do not wait indefinitely for a failed process-tree termination.
      killTimer = setTimeout(() => finish(null), 2_000);
    }
    function finish(exitCode: number | null): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      request.signal?.removeEventListener("abort", abort);
      resolve({ exitCode, blockedReason });
    }
    // Drain output, but never return raw installer logs (registry credentials,
    // private URLs and environment values can appear in errors).
    const consume = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > request.maxBuffer) stop("Dependency install exceeded its output limit.");
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    const timer = setTimeout(() => stop("Dependency install timed out."), request.timeoutMs);
    const abort = () => stop("Dependency preparation cancelled.");
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    child.on("error", () => {
      blockedReason = "Unable to start npm dependency installation.";
      finish(null);
    });
    child.on("close", finish);
  });
};

/** Install only declared dependencies, in known project package directories. */
export async function prepareProjectDependencies(
  projectDir: string,
  options: { signal?: AbortSignal; executor?: DependencyExecutor } = {},
): Promise<DependencyPreparationResult> {
  const checks: DependencyPreparationResult["checks"] = [];
  let root: string;
  try {
    root = await fs.realpath(projectDir);
  } catch {
    return { ready: false, output: "Project directory unavailable.", checks };
  }
  for (const directory of [".", "client", "frontend", "backend", "server"]) {
    const cwd = directory === "." ? root : path.join(root, directory);
    try {
      const stat = await fs.lstat(cwd);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      await fs.lstat(path.join(cwd, "package.json"));
    } catch {
      continue;
    }
    let readiness = await checkLocalDependencies(cwd);
    let installed = false;
    if (!readiness.ready && !readiness.missing.length) {
      checks.push({ ...readiness, directory, installed });
      continue;
    }
    if (!readiness.ready) {
      if (options.signal?.aborted)
        readiness = { ...readiness, reason: "Dependency preparation cancelled." };
      else {
        installed = true;
        try {
          const result = await (options.executor ?? executeDependencyInstall)({
            cwd,
            args: DEPENDENCY_INSTALL_ARGS,
            env: dependencyInstallEnvironment(),
            timeoutMs: DEPENDENCY_INSTALL_TIMEOUT_MS,
            maxBuffer: DEPENDENCY_OUTPUT_LIMIT,
            signal: options.signal,
          });
          readiness = await checkLocalDependencies(cwd);
          if (result.exitCode !== 0 || result.blockedReason || options.signal?.aborted) {
            readiness = {
              ...readiness,
              ready: false,
              reason: options.signal?.aborted
                ? "Dependency preparation cancelled."
                : `Dependency installation failed (exit ${result.exitCode ?? "unavailable"}).`,
            };
          }
        } catch {
          readiness = {
            ...readiness,
            ready: false,
            reason: "Dependency installation could not complete.",
          };
        }
      }
    }
    checks.push({ ...readiness, directory, installed });
    if (options.signal?.aborted) break;
  }
  return {
    ready: checks.every((check) => check.ready),
    output:
      checks.map((check) => `${check.directory}: ${check.reason}`).join("\n") ||
      "No Node package manifests found.",
    checks,
  };
}
