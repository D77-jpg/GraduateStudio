import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { safeCodexText } from "@/lib/codex-progress";

export interface CodexAcceptanceCheck {
  name: string;
  status: "passed" | "failed" | "blocked" | "not_run";
  exitCode?: number;
  command?: string;
  durationMs?: number;
  output: string;
}
export interface CodexAcceptanceResult {
  status: "passed" | "failed" | "blocked";
  checks: CodexAcceptanceCheck[];
}
const IMAGE = "gs-codex-worker:0.150.1";
const ROOTS = ["", "client", "backend", "server"] as const;
const OUTPUT_LIMIT = 16 * 1024;
const SCOPE =
  "Independent engineering verification only; not business acceptance or proof of UI semantics.";

/** Only the Docker client runs on the host. Never execute a generated command on the host. */
function docker(args: string[], timeoutMs = 30_000, signal?: AbortSignal) {
  return new Promise<{
    code: number | null;
    output: string;
    interrupted: boolean;
    error: boolean;
    overflow: boolean;
  }>((resolve) => {
    let output = "",
      interrupted = false,
      error = false;
    // Do not forward application/model credentials, Docker remote endpoints, or user configuration.
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn("docker", args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let bytes = 0,
      overflow = false;
    const collect = (channel: keyof typeof decoders, chunk: Buffer) => {
      // One shared byte budget, independent UTF-8 decoders: interleaved split codepoints stay intact.
      const available = Math.max(0, 65536 - bytes);
      if (chunk.length > available) overflow = true;
      const accepted = chunk.subarray(0, available);
      bytes += accepted.length;
      output += decoders[channel].write(accepted);
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    const stop = () => {
      interrupted = true;
      child.kill();
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      // Discard partial codepoints only when the byte bound cut the stream; never emit replacement text.
      if (!overflow) output += decoders.stdout.end() + decoders.stderr.end();
      resolve({ code, output, interrupted, error, overflow });
    };
    child.once("error", () => {
      error = true;
      finish(null);
    });
    child.once("close", finish);
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    return !(await lstat(file)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function dependenciesAvailable(
  stage: string,
  root: string,
  manifest: Record<string, unknown>,
) {
  const declared = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
  ].some((value) => value && typeof value === "object" && Object.keys(value).length > 0);
  if (!declared && !(await exists(path.join(stage, root, "package-lock.json")))) return true;
  for (const candidate of root
    ? [path.join(stage, root, "node_modules"), path.join(stage, "node_modules")]
    : [path.join(stage, "node_modules")]) {
    if (await exists(candidate)) {
      if ((await lstat(candidate)).isDirectory()) return true;
    }
  }
  return false;
}
function emptyTests(output: string): boolean {
  return /no test(?:s| files| suites)?(?: were)? found|no tests? (?:to run|executed)|\btests?\s*[:=]?\s*0\b|\b0\s+(?:tests?|passing|passed)\b/i.test(
    output,
  );
}
function testEvidence(output: string): boolean {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  if (
    emptyTests(text) ||
    /\bok\s+\d+[^\n]*#\s*(?:skip|todo)\b|\b(?:all tests|test suite)\s+skipped\b/i.test(text) ||
    /\b[1-9]\d*\s+(?:skipped|todo|pending)\b|\b(?:skipped|todo|pending)\s*[:=]?\s*[1-9]\d*\b/i.test(
      text,
    )
  )
    return false;
  return /(?:\b[1-9]\d*\s+(?:passed|passing)\b|(?:^|\n)\s*(?:#\s*|ℹ\s*)?(?:tests|pass)\s+[1-9]\d*\b|(?:^|\n)\s*ok\s+[1-9]\d*\b)/i.test(
    text,
  );
}

/** Caller supplies an audited disposable stage. No install, model, CLI agent, secrets or sockets. */
export async function runCodexAcceptance(
  stage: string,
  signal?: AbortSignal,
): Promise<CodexAcceptanceResult> {
  const checks: CodexAcceptanceCheck[] = [];
  const planned: Array<{ root: string; script: "build" | "test"; check: CodexAcceptanceCheck }> =
    [];
  const result = (): CodexAcceptanceResult => ({
    status: checks.some((c) => c.status === "failed")
      ? "failed"
      : checks.some((c) => c.status === "blocked") || !checks.some((c) => c.status === "passed")
        ? "blocked"
        : "passed",
    checks,
  });
  try {
    if (signal?.aborted) throw new Error("cancelled");
    const original = await lstat(stage);
    if (!original.isDirectory() || original.isSymbolicLink()) throw new Error("invalid stage");
    stage = await realpath(stage);
    if (stage.includes(",")) throw new Error("invalid mount path");
    for (const root of ROOTS) {
      const directory = path.join(stage, root);
      if (!(await exists(directory))) continue;
      const file = path.join(directory, "package.json");
      if (!(await exists(file))) continue;
      if ((await lstat(file)).size > 1024 * 1024) throw new Error("oversized manifest");
      const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
        throw new Error("invalid manifest");
      const scripts = manifest.scripts as Record<string, unknown> | undefined;
      const ready = await dependenciesAvailable(stage, root, manifest);
      for (const script of ["build", "test"] as const) {
        const declared = scripts && typeof scripts[script] === "string" && scripts[script].trim();
        const check: CodexAcceptanceCheck = {
          name: `${root || "."}:${script}`,
          status: "not_run",
          output: declared ? "Not executed." : `No declared ${script} script. ${SCOPE}`,
        };
        checks.push(check);
        if (!declared) continue;
        if (!ready) {
          check.status = "blocked";
          check.output = "Dependencies absent; offline verification cannot install dependencies.";
        } else planned.push({ root, script, check });
      }
    }
    if (!planned.length) return result();
    const image = await docker(["image", "inspect", IMAGE, "--format", "{{json .}}"]);
    let id = "";
    if (!image.error && image.code === 0 && !image.interrupted) {
      const parsed = JSON.parse(image.output);
      if (parsed.Os === "linux" && /^sha256:[a-f0-9]{64}$/.test(parsed.Id)) id = parsed.Id;
    }
    if (!id) throw new Error("worker unavailable");
    for (const { root, script, check } of planned) {
      if (signal?.aborted) {
        check.status = "blocked";
        check.output = "Verification cancelled.";
        continue;
      }
      const name = `gs-codex-acceptance-${randomUUID()}`;
      try {
        // Creation is bounded and awaited without cancellation so cleanup cannot race late creation.
        const created = await docker([
          "create",
          "--pull",
          "never",
          "--name",
          name,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "10001:10001",
          "--pids-limit",
          "256",
          "--memory",
          "2g",
          "--cpus",
          "2",
          "--log-driver",
          "none",
          "--tmpfs",
          // `exec` is required: Docker's --tmpfs default is noexec, which breaks
          // interpreters/toolchains that map or execute files under /tmp.
          "/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777",
          "--mount",
          `type=bind,src=${stage},dst=/workspace`,
          "--workdir",
          `/workspace${root ? `/${root}` : ""}`,
          "--env",
          "CI=true",
          "--env",
          "HOME=/tmp/home",
          "--env",
          "npm_config_cache=/tmp/npm-cache",
          "--env",
          "npm_config_offline=true",
          "--env",
          "npm_config_update_notifier=false",
          "--entrypoint",
          "npm",
          id,
          "run",
          script,
        ]);
        if (created.error || created.interrupted || created.code !== 0) {
          check.status = "blocked";
          check.output = "Unable to create isolated verification container.";
        } else if (signal?.aborted) {
          check.status = "blocked";
          check.output = "Verification cancelled.";
        } else {
          check.command = `npm run ${script}`;
          const started = performance.now();
          const run = await docker(["start", "--attach", name], 120_000, signal);
          check.durationMs = Math.round(performance.now() - started);
          // `docker start --attach` client success is not sufficient proof of command success.
          if (!run.error && !run.interrupted && run.code === 0) {
            const inspected = await docker(["inspect", "--format", "{{json .State}}", name]);
            try {
              const state = JSON.parse(inspected.output);
              if (
                inspected.code !== 0 ||
                inspected.error ||
                inspected.interrupted ||
                state.Running !== false ||
                !Number.isInteger(state.ExitCode)
              )
                run.error = true;
              else run.code = state.ExitCode;
            } catch {
              run.error = true;
            }
          }
          check.output = safeCodexText(run.output).slice(0, OUTPUT_LIMIT);
          if (run.error || run.interrupted || run.code === null || run.code === 125) {
            check.status = "blocked";
            check.output =
              `${run.interrupted ? "Verification cancelled or exceeded 120s timeout." : "Docker verification unavailable."}\n${check.output}`.slice(
                0,
                OUTPUT_LIMIT,
              );
          } else {
            check.exitCode = run.code;
            const missing =
              /(?:command not found|: not found|cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ENOENT[^\n]*(?:node_modules|package\.json))/i.test(
                run.output,
              );
            const empty = script === "test" && !testEvidence(run.output);
            check.status =
              missing || (script === "test" && emptyTests(run.output))
                ? "blocked"
                : run.code !== 0
                  ? "failed"
                  : empty || run.overflow
                    ? "blocked"
                    : "passed";
            if (empty && run.code === 0)
              check.output = `No unambiguous executed, non-skipped test evidence.\n${check.output}`;
            check.output = `${SCOPE}\n${check.output}`.slice(0, OUTPUT_LIMIT);
          }
        }
      } finally {
        await docker(["rm", "--force", name]);
        const remaining = await docker([
          "ps",
          "--all",
          "--filter",
          `name=^/${name}$`,
          "--format",
          "{{.Names}}",
        ]);
        if (
          remaining.error ||
          remaining.interrupted ||
          remaining.code !== 0 ||
          remaining.output.trim()
        ) {
          check.status = "blocked";
          check.output =
            "Verification container cleanup could not be confirmed; results must not be published.";
        }
      }
    }
  } catch {
    for (const { check } of planned)
      if (check.status === "not_run") {
        check.status = "blocked";
        check.output = "Independent isolated verification unavailable; no host fallback.";
      }
    checks.push({
      name: "verification-environment",
      status: "blocked",
      output: `Invalid stage, manifest, cancellation, or unavailable local worker. ${SCOPE}`,
    });
  }
  return result();
}
