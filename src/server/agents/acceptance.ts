import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { acceptanceTestEnvironment } from "./acceptance-environment";
import {
  AcceptanceEvidenceCollector,
  MYSQL_ENVIRONMENT_BLOCKED_REASON,
} from "./acceptance-evidence";
import {
  ACCEPTANCE_LIMITATIONS,
  planProjectAcceptance,
  isSafeNodeSourcePath,
  summarizeAcceptance,
  type AcceptanceCheck,
  type AcceptanceCommand,
  type AcceptanceReport,
  type AcceptanceSnapshot,
} from "@/lib/acceptance";

export type { AcceptanceReport, AcceptanceCheck } from "@/lib/acceptance";
export const ACCEPTANCE_OUTPUT_LIMIT = 16_000;

export interface AcceptanceExecutionResult {
  exitCode: number | null;
  output: string;
  durationMs: number;
  blockedReason?: string;
  failureEvidence?: string;
  failureEvidenceIncomplete?: boolean;
  environmentBlockedReason?: string;
}
export interface AcceptanceOptions {
  signal?: AbortSignal;
  executor?: AcceptanceExecutor;
  /**
   * Opt-in partial acceptance: inspect the bounded snapshot as usual, but execute
   * and return only these check IDs. A targeted report's `passed` status applies
   * only to those checks, NOT to full project acceptance. No test paths are added:
   * frontend-test/backend-test still run the declared, allowlisted whole suite.
   * Empty selections are blocked; unavailable/unknown IDs produce blocked checks.
   */
  onlyCheckIds?: readonly string[];
}

const TRUNCATION_MARKER = "\n[输出已截断]\n";

/** Preserve startup context and final failure evidence within the same character cap. */
function trimOutput(output: string, limit = ACCEPTANCE_OUTPUT_LIMIT, truncated = false): string {
  if (!truncated && output.length <= limit) return output;
  const available = Math.max(0, limit - TRUNCATION_MARKER.length);
  const head = Math.ceil(available / 2);
  const tail = available - head;
  return `${output.slice(0, head)}${TRUNCATION_MARKER}${tail ? output.slice(-tail) : ""}`;
}

export type AcceptanceExecutor = (
  command: AcceptanceCommand,
  cwd: string,
  signal?: AbortSignal,
) => Promise<AcceptanceExecutionResult>;

// Deliberately no command strings from model responses or package script values.
const ALLOWED_COMMANDS = {
  "frontend-build": { tool: "npm", args: ["--ignore-scripts", "run", "build"] },
  "frontend-test": { tool: "npm", args: ["--ignore-scripts", "run", "test", "--", "--run"] },
  "backend-verify": { tool: "mvn", args: ["-B", "-f", "pom.xml", "verify"] },
} as const;

export function acceptanceSpawnSpec(
  command: AcceptanceCommand,
  platform: string = process.platform,
): {
  file: string;
  args: string[];
} {
  const nodeDirectory = command.directory === "backend" || command.directory === "server";
  if (
    command.id === "backend-syntax" &&
    command.tool === "node" &&
    nodeDirectory &&
    command.args.length === 2 &&
    command.args[0] === "--check" &&
    isSafeNodeSourcePath(command.args[1])
  ) {
    return { file: "node", args: [...command.args] };
  }
  if (
    command.id === "backend-test" &&
    command.tool === "node" &&
    nodeDirectory &&
    JSON.stringify(command.args) === JSON.stringify(["--test"])
  ) {
    return { file: "node", args: ["--test"] };
  }
  const allowed =
    command.id === "backend-build" && nodeDirectory
      ? ALLOWED_COMMANDS["frontend-build"]
      : command.id === "backend-test" && nodeDirectory && command.tool === "npm"
        ? ALLOWED_COMMANDS["frontend-test"]
        : ALLOWED_COMMANDS[command.id as keyof typeof ALLOWED_COMMANDS];
  if (
    !allowed ||
    command.tool !== allowed.tool ||
    JSON.stringify(command.args) !== JSON.stringify(allowed.args)
  ) {
    throw new Error("Acceptance command is not allowlisted.");
  }
  if (platform === "win32") {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `${allowed.tool} ${allowed.args.join(" ")}`],
    };
  }
  return { file: allowed.tool, args: [...allowed.args] };
}

/** Bounded execution with process-tree termination; missing tools/timeouts/abort are blockers. */
export const executeAcceptanceCommand: AcceptanceExecutor = async (command, cwd, signal) => {
  const spec = acceptanceSpawnSpec(command);
  if (signal?.aborted)
    return Promise.resolve({
      exitCode: null,
      output: "工程检查已取消。",
      durationMs: 0,
      blockedReason: "工程检查已取消。",
    });
  if (command.id === "backend-syntax") {
    try {
      let current = cwd;
      const root = await fs.lstat(current);
      if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("Invalid source root.");
      const parts = command.args[1].split("/");
      for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        const stat = await fs.lstat(current);
        if (
          stat.isSymbolicLink() ||
          (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.size > 256_000)
        ) {
          throw new Error("Source path is not a bounded regular file.");
        }
      }
    } catch (error) {
      return {
        exitCode: null,
        output: String(error),
        durationMs: 0,
        blockedReason: "后端语法检查路径无法安全验证。",
      };
    }
  }
  let executionEnvironment = process.env;
  if (command.id === "backend-test" && command.tool === "node") {
    try {
      executionEnvironment = await acceptanceTestEnvironment(cwd);
    } catch (error) {
      return {
        exitCode: null,
        output: String(error),
        durationMs: 0,
        blockedReason: "本地测试数据库配置无效，请检查 .env.test.local；未执行测试。",
      };
    }
  }
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let truncated = false;
    let done = false;
    let blockedReason: string | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(spec.file, spec.args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...executionEnvironment,
        CI: "true",
        ...(command.id === "frontend-test" ||
        (command.id === "backend-test" && command.tool === "npm")
          ? { NODE_ENV: "test" }
          : {}),
        npm_config_ignore_scripts: "true",
        GS_NO_AUTO_INSTALL: "1",
      },
    });
    const evidence = new AcceptanceEvidenceCollector();
    const append = (channel: "stdout" | "stderr", chunk: Buffer) => {
      const text = evidence.write(channel, chunk);
      const combined = output + text;
      if (combined.length > ACCEPTANCE_OUTPUT_LIMIT) {
        truncated = true;
        const head = Math.ceil(ACCEPTANCE_OUTPUT_LIMIT / 2);
        output = combined.slice(0, head) + combined.slice(-(ACCEPTANCE_OUTPUT_LIMIT - head));
      } else {
        output = combined;
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      signal?.removeEventListener("abort", onAbort);
      if (
        exitCode === 9009 ||
        /(?:'npm'|'mvn'|'node') is not recognized|(?:npm|mvn|node): (?:command )?not found/i.test(
          output,
        )
      ) {
        blockedReason ??= `缺少所需工具 ${command.tool}，无法执行检查。`;
      }
      resolve({
        exitCode,
        output: trimOutput(
          `${output}${blockedReason ? `\n${blockedReason}` : ""}`,
          ACCEPTANCE_OUTPUT_LIMIT,
          truncated,
        ),
        durationMs: Date.now() - started,
        blockedReason,
        ...evidence.finish(),
      });
    };
    const stop = (reason: string) => {
      if (done || blockedReason) return;
      blockedReason = reason;
      if (child.pid) {
        if (process.platform === "win32") {
          // Fixed executable/flags and OS-issued numeric PID, never project input.
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.on("error", () => {
            child.kill("SIGKILL");
          });
          killer.on("exit", () => {
            if (!done) child.kill("SIGKILL");
          });
          const killTimer = setTimeout(() => killer.kill(), 2_000);
          killTimer.unref();
          killer.on("close", () => clearTimeout(killTimer));
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
      // Inherited pipe handles must not extend the check indefinitely.
      stopTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.kill("SIGKILL");
        finish(null);
      }, 3_000);
    };
    const onAbort = () => stop("工程检查已取消。");
    const timer = setTimeout(
      () => stop(`命令超过 ${command.timeoutMs}ms 执行时限。`),
      command.timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on("error", (error: NodeJS.ErrnoException) => {
      blockedReason =
        error.code === "ENOENT"
          ? `缺少所需工具 ${command.tool}，无法执行检查。`
          : `无法执行检查：${error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
};

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|svelte|html|java|kt)$/i;
const IGNORE_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "target",
  "coverage",
  ".workspace",
]);

export async function inspectAcceptanceProject(
  projectDir: string,
  signal?: AbortSignal,
): Promise<AcceptanceSnapshot> {
  const snapshot: AcceptanceSnapshot = {
    backend: false,
    backendHasTests: false,
    sources: [],
    inspectionErrors: [],
  };
  const errors = snapshot.inspectionErrors!;
  const regularFile = async (relative: string) => {
    try {
      const stat = await fs.lstat(path.join(projectDir, relative));
      if (stat.isSymbolicLink()) {
        errors.push(`Symlink not inspected: ${relative}`);
        return false;
      }
      return stat.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        errors.push(`Cannot inspect ${relative}: ${String(error)}`);
      return false;
    }
  };
  // Reject symlinked root/subprojects instead of traversing outside the project.
  try {
    if (!(await fs.lstat(projectDir)).isDirectory())
      throw new Error("Project root is not a regular directory.");
  } catch (error) {
    errors.push(String(error));
    return snapshot;
  }
  const client = await fs.lstat(path.join(projectDir, "client")).catch(() => null);
  const server = await fs.lstat(path.join(projectDir, "server")).catch(() => null);
  if (client?.isSymbolicLink()) errors.push("Symlink not inspected: client");
  if (server?.isSymbolicLink()) errors.push("Symlink not inspected: server");
  const directory =
    !client?.isSymbolicLink() && (await regularFile("client/package.json")) ? "client" : ".";
  const manifest = directory === "client" ? "client/package.json" : "package.json";
  if (await regularFile(manifest)) {
    try {
      if ((await fs.stat(path.join(projectDir, manifest))).size > 128_000)
        throw new Error("Manifest exceeds inspection limit.");
      snapshot.frontend = {
        directory,
        packageJson: JSON.parse(await fs.readFile(path.join(projectDir, manifest), "utf8")),
      };
    } catch (error) {
      errors.push(`Invalid ${manifest}: ${String(error)}`);
    }
  }
  snapshot.backend = !server?.isSymbolicLink() && (await regularFile("server/pom.xml"));
  for (const backendDirectory of ["backend", "server"] as const) {
    const stat = await fs.lstat(path.join(projectDir, backendDirectory)).catch(() => null);
    if (stat?.isSymbolicLink()) {
      if (backendDirectory === "backend") errors.push("Symlink not inspected: backend");
      continue;
    }
    const file = `${backendDirectory}/package.json`;
    if (!(await regularFile(file))) continue;
    try {
      if ((await fs.stat(path.join(projectDir, file))).size > 128_000)
        throw new Error("Manifest exceeds inspection limit.");
      const packageJson = JSON.parse(await fs.readFile(path.join(projectDir, file), "utf8"));
      snapshot.nodeBackend ??= { directory: backendDirectory, packageJson };
    } catch (error) {
      errors.push(`Invalid ${file}: ${String(error)}`);
    }
  }
  let entries = 0;
  let bytes = 0;
  let capped = false;
  const walk = async (relative: string): Promise<void> => {
    if (signal?.aborted) {
      if (!errors.includes("Inspection aborted.")) errors.push("Inspection aborted.");
      return;
    }
    if (capped) return;
    let listing;
    try {
      listing = await fs.readdir(path.join(projectDir, relative), { withFileTypes: true });
    } catch (error) {
      errors.push(`Cannot scan ${relative || "."}: ${String(error)}`);
      return;
    }
    listing.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of listing) {
      if (signal?.aborted) {
        errors.push("Inspection aborted.");
        return;
      }
      if (++entries > 4_000) {
        capped = true;
        break;
      }
      const file = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(`Symlink not inspected: ${file}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (!IGNORE_DIRECTORIES.has(entry.name)) await walk(file);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.test(file)) {
        try {
          const stat = await fs.stat(path.join(projectDir, file));
          if (stat.size > 256_000) {
            errors.push(`Source exceeds inspection limit: ${file}`);
            continue;
          }
          if ((bytes += stat.size) > 4_000_000) {
            capped = true;
            break;
          }
          snapshot.sources.push({
            path: file,
            content: await fs.readFile(path.join(projectDir, file), "utf8"),
          });
          if (/^server\/src\/test\/.*\.(?:java|kt)$/.test(file)) snapshot.backendHasTests = true;
        } catch (error) {
          errors.push(`Cannot read ${file}: ${String(error)}`);
        }
      }
      if (capped) break;
    }
  };
  await walk("");
  if (capped) errors.push("源码扫描超过文件数量/字节上限，扫描未完成。");
  snapshot.inspectionErrors = errors.slice(0, 30).map((error) => error.slice(0, 400));
  if (errors.length > 30) snapshot.inspectionErrors.push("扫描诊断过多，已截断；不能判定通过。");
  return snapshot;
}

export async function runProjectAcceptance(
  projectDir: string,
  options: AcceptanceOptions = {},
): Promise<AcceptanceReport> {
  const snapshot = await inspectAcceptanceProject(projectDir, options.signal);
  const plan = planProjectAcceptance(snapshot);
  const selected = options.onlyCheckIds === undefined ? undefined : new Set(options.onlyCheckIds);
  const checks: AcceptanceCheck[] = plan.checks.filter(
    (check) => !selected || selected.has(check.id),
  );
  if (selected) {
    for (const id of selected) {
      const existing = checks.filter((check) => check.id === id);
      const commands = plan.commands.filter((command) => command.id === id);
      const preconditions = [
        ...plan.checks.filter((check) => check.id === "inspection"),
        ...(id === "backend-verify"
          ? plan.checks.filter((check) => check.id === "backend-tests")
          : []),
      ];
      if (preconditions.length) {
        checks.push({
          id,
          label: commands[0]?.label ?? existing[0]?.label ?? id,
          status: "blocked",
          output: preconditions.map((check) => check.output).join("\n"),
          durationMs: 0,
        });
      } else if (!existing.length && !commands.length) {
        const hasBackendTests =
          id === "backend-tests" && snapshot.backend && snapshot.backendHasTests;
        checks.push({
          id,
          label: id === "backend-tests" ? "后端测试源码" : id,
          status: hasBackendTests ? "passed" : "blocked",
          output: hasBackendTests
            ? "server/src/test 下找到测试源码；仅表示源码存在，不证明测试执行通过。"
            : "所选检查不可用或无法识别；未执行命令，不能判定通过。",
          durationMs: 0,
        });
      }
    }
  }
  const preblockedIds = new Set(
    checks.filter((check) => check.status === "blocked").map((check) => check.id),
  );
  let syntaxStarted: number | undefined;
  for (const plannedCommand of plan.commands) {
    if (selected && (!selected.has(plannedCommand.id) || preblockedIds.has(plannedCommand.id)))
      continue;
    let command = plannedCommand;
    let commandSignal = options.signal;
    if (command.id === "backend-syntax") {
      syntaxStarted ??= Date.now();
      const remaining = 60_000 - (Date.now() - syntaxStarted);
      if (remaining <= 0) {
        checks.push({
          id: command.id,
          label: "后端 JavaScript 语法检查",
          status: "blocked",
          output: "后端语法检查超过整体 60000ms 时限；源码检查未完成。",
          durationMs: 0,
        });
        continue;
      }
      command = { ...command, timeoutMs: Math.min(command.timeoutMs, remaining) };
      const deadline = AbortSignal.timeout(remaining);
      commandSignal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    }
    if (options.signal?.aborted) {
      checks.push({
        id: command.id,
        label: command.label,
        status: "blocked",
        output: "工程检查已取消；未启动命令。",
        durationMs: 0,
      });
      continue;
    }
    try {
      const result = await (options.executor ?? executeAcceptanceCommand)(
        command,
        path.resolve(projectDir, command.directory),
        commandSignal,
      );
      let blockedReason = result.blockedReason;
      if (command.id === "backend-test" && result.exitCode !== 0) {
        blockedReason ??= result.environmentBlockedReason;
        if (
          /(?:集成测试无法连接 MySQL|无法连接 MySQL 测试库)[^\n]*(?:ENOTFOUND|ECONNREFUSED|ETIMEDOUT)/.test(
            `${result.output}\n${result.failureEvidence ?? ""}`,
          )
        )
          blockedReason ??= MYSQL_ENVIRONMENT_BLOCKED_REASON;
      }
      let failureReason: string | undefined;
      const plainOutput = result.output.replace(/\x1b\[[0-9;]*m/g, "");
      if (
        command.id === "frontend-test" ||
        (command.id === "backend-test" && command.tool === "npm")
      ) {
        const summaries = plainOutput
          .split(/\r?\n/)
          .filter((line) => /^\s*(?:Tests|Test Files)\s+/.test(line));
        if (summaries.some((line) => /\b[1-9]\d*\s+failed\b/.test(line))) {
          failureReason = "Vitest 摘要包含失败测试；即使命令退出码为零也不能通过。";
        } else if (
          !blockedReason &&
          result.exitCode === 0 &&
          !/^\s*Tests\s+[^\r\n]*\b[1-9]\d*\s+passed\b/m.test(plainOutput)
        ) {
          blockedReason = "Vitest 未提供实际通过测试的摘要，不能证明测试已运行。";
        }
      }
      if (
        command.id === "backend-test" &&
        command.tool === "npm" &&
        /^\s*(?:Tests|Test Files)\s+[^\r\n]*\b[1-9]\d*\s+(?:skipped|todo)\b/m.test(plainOutput)
      ) {
        blockedReason ??= "后端 Vitest 包含跳过测试，不能判定完整测试通过。";
      }
      if (command.id === "backend-test" && command.tool === "node") {
        const counts = (name: string) =>
          [
            ...plainOutput.matchAll(
              new RegExp(`^\\s*(?:#\\s*|ℹ\\s*)?${name}\\s+(\\d+)\\s*$`, "gm"),
            ),
          ].map((match) => Number(match[1]));
        const tests = counts("tests");
        const passed = counts("pass");
        const failed = counts("fail");
        const skipped = counts("skipped");
        const cancelled = counts("cancelled");
        const todo = counts("todo");
        if (failed.some((count) => count > 0) || /^\s*not ok\b/m.test(plainOutput)) {
          failureReason = "Node 测试摘要包含失败；即使命令退出码为零也不能通过。";
        } else if (
          !blockedReason &&
          result.exitCode === 0 &&
          (tests.length !== 1 ||
            passed.length !== 1 ||
            failed.length !== 1 ||
            skipped.length !== 1 ||
            cancelled.length !== 1 ||
            todo.length !== 1 ||
            tests[0] <= 0 ||
            passed[0] !== tests[0] ||
            failed[0] !== 0 ||
            skipped[0] !== 0 ||
            cancelled[0] !== 0 ||
            todo[0] !== 0)
        ) {
          blockedReason = "Node 未提供非零通过且零失败/跳过/取消的完整测试摘要，不能证明测试通过。";
        }
      }
      if (command.id === "backend-verify") {
        const summaries = [
          ...plainOutput.matchAll(
            /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/g,
          ),
        ];
        if (summaries.some((match) => Number(match[2]) > 0 || Number(match[3]) > 0)) {
          failureReason = "Maven 摘要包含测试失败或错误；即使命令退出码为零也不能通过。";
        } else if (
          !blockedReason &&
          result.exitCode === 0 &&
          !summaries.some((match) => Number(match[1]) > Number(match[4]))
        ) {
          blockedReason = "Maven 未提供实际执行测试的摘要，不能排除跳过测试。";
        }
      }
      // A proven unavailable integration database is an environment blocker, not a
      // code assertion repair target, even though the runner's failed count is nonzero.
      if (blockedReason === MYSQL_ENVIRONMENT_BLOCKED_REASON) failureReason = undefined;
      checks.push({
        id: command.id,
        label: command.label,
        command: `${command.tool} ${command.args.join(" ")}`,
        status:
          blockedReason === MYSQL_ENVIRONMENT_BLOCKED_REASON
            ? "blocked"
            : failureReason
              ? "failed"
              : blockedReason
                ? "blocked"
                : result.exitCode === 0
                  ? "passed"
                  : "failed",
        output: trimOutput(
          `${failureReason || blockedReason ? `${failureReason || blockedReason}\n` : ""}${result.output || (result.exitCode === 0 ? "命令成功退出。" : `命令退出码：${result.exitCode}。`)}`,
        ),
        durationMs: result.durationMs,
        ...(result.failureEvidence ? { failureEvidence: result.failureEvidence } : {}),
        ...(result.failureEvidenceIncomplete ? { failureEvidenceIncomplete: true } : {}),
      });
    } catch (error) {
      checks.push({
        id: command.id,
        label: command.label,
        status: "blocked",
        output: `无法执行检查：${String(error)}`.slice(0, ACCEPTANCE_OUTPUT_LIMIT),
        durationMs: 0,
      });
    }
  }
  const syntaxChecks = checks.filter((check) => check.id === "backend-syntax");
  const reportChecks = checks.filter((check) => check.id !== "backend-syntax");
  if (syntaxChecks.length)
    reportChecks.push({
      id: "backend-syntax",
      label: "后端 JavaScript 语法检查",
      status: summarizeAcceptance(syntaxChecks),
      output: trimOutput(
        `${syntaxChecks.length} 个源码语法检查结果（不执行源码，不能证明运行时行为）。\n${syntaxChecks.map((check) => `${check.command ?? check.label}: ${check.status}\n${check.output}`).join("\n")}`,
      ),
      durationMs: syntaxChecks.every((check) => check.durationMs !== undefined)
        ? syntaxChecks.reduce((sum, check) => sum + check.durationMs!, 0)
        : undefined,
    });
  return {
    version: 1,
    status: summarizeAcceptance(reportChecks),
    checks: reportChecks,
    limitations: [
      ...ACCEPTANCE_LIMITATIONS,
      ...(selected
        ? ["本报告仅涵盖所选检查；通过仅表示这些检查通过，不代表完整工程验收通过。"]
        : []),
    ],
  };
}
