import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { safeJoin } from "../workspace/paths";
import { acceptanceTestEnvironment } from "./acceptance-environment";

const relativePath = z.string().min(1).max(512);
const directory = relativePath.optional().default(".");
/** Strict, bounded requests: no command strings, runner flags or write operations. */
export const investigationToolRequestSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("list_files"), directory }).strict(),
  z
    .object({
      tool: z.literal("read_file"),
      path: relativePath,
      offset: z.number().int().min(1).max(10_000).optional().default(1),
      limit: z.number().int().min(1).max(200).optional().default(200),
    })
    .strict(),
  z
    .object({ tool: z.literal("search_text"), query: z.string().min(1).max(256), directory })
    .strict(),
  z
    .object({
      tool: z.literal("node_test"),
      directory: z.enum(["backend", "server"]),
      testPath: relativePath,
    })
    .strict(),
]);
export type InvestigationToolRequest = z.input<typeof investigationToolRequestSchema>;

const OUTPUT_LIMIT = 16_000;
const READ_LIMIT = 512_000;
const IGNORED = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  "coverage",
  ".workspace",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".ssh",
  ".aws",
]);
function protectedName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    IGNORED.has(lower) ||
    lower.startsWith(".env") ||
    /\.(?:pem|key|p12|pfx|keystore)$/.test(lower) ||
    /^(?:id_rsa|id_ed25519|credentials(?:\.json)?|secrets?(?:\..*)?)$/.test(lower)
  );
}
function normalize(input: string, allowRoot = false): string {
  if (allowRoot && input === ".") return ".";
  const normalized = input.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\x00-\x1f:*?<>|]/.test(part) ||
        /[ .]$/.test(part) ||
        protectedName(part),
    )
  ) {
    throw new Error("Unsafe or protected relative path.");
  }
  return normalized;
}

/** Check every ancestor, not just the final file (including the supplied root). */
async function validateRoot(projectDir: string): Promise<string> {
  const root = path.resolve(projectDir);
  const anchor = path.parse(root).root;
  let current = anchor;
  for (const part of path.relative(anchor, root).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Project ancestor is not a regular directory.");
  }
  return root;
}
async function validatePath(root: string, relative: string, kind: "file" | "directory") {
  const target = safeJoin(root, relative);
  let current = root;
  const parts = relative === "." ? [] : relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) {
      throw new Error("Symbolic links and non-directory path components are blocked.");
    }
  }
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error(`Requested path is not a regular ${kind}.`);
  }
  return { target, stat };
}
async function readBounded(target: string, maxBytes: number) {
  const handle = await fs.open(target, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Not a regular file.");
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (text.includes("\0")) throw new Error("Binary files are blocked.");
    return { text, truncated: stat.size > bytesRead, bytesRead };
  } finally {
    await handle.close();
  }
}

/** A separate runner is necessary: acceptance's allowlist intentionally permits only whole suites. */
async function runNodeTest(cwd: string, testPath: string, signal?: AbortSignal): Promise<object> {
  let env: NodeJS.ProcessEnv;
  try {
    env = await acceptanceTestEnvironment(cwd);
  } catch {
    return {
      tool: "node_test",
      ok: false,
      exitCode: null,
      blockedReason: "Invalid local test database configuration; no test executed.",
    };
  }
  // Do not allow inherited Node preload/runner options to alter the fixed command.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  if (signal?.aborted) throw new Error("Investigation aborted.");
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--test", testPath], {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, CI: "true", GS_NO_AUTO_INSTALL: "1", npm_config_ignore_scripts: "true" },
    });
    let output = "";
    let truncated = false;
    let finished = false;
    let blockedReason: string | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: Buffer) => {
      const combined = output + chunk.toString("utf8");
      if (combined.length > OUTPUT_LIMIT) {
        truncated = true;
        output = combined.slice(0, 8_000) + combined.slice(-8_000);
      } else output = combined;
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener("abort", onAbort);
      // Timeout/abort and exit handlers own tree cleanup; avoid killing a reused PID on close.
      if (exitCode === 0 && !blockedReason) {
        const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
        const count = (name: string) =>
          [...plain.matchAll(new RegExp(`^\\s*(?:#\\s*|ℹ\\s*)?${name}\\s+(\\d+)\\s*$`, "gm"))].map(
            (match) => Number(match[1]),
          );
        const tests = count("tests");
        const passed = count("pass");
        const other = ["fail", "skipped", "cancelled", "todo"].map(count);
        if (
          tests.length !== 1 ||
          passed.length !== 1 ||
          tests[0] <= 0 ||
          passed[0] !== tests[0] ||
          other.some((values) => values.length !== 1 || values[0] !== 0)
        ) {
          blockedReason =
            "Node did not report real passing tests with zero failures/skips/cancellations/todos.";
        }
      }
      resolve({
        tool: "node_test",
        ok: exitCode === 0 && !blockedReason,
        testPath,
        exitCode,
        output,
        truncated,
        durationMs: Date.now() - started,
        ...(blockedReason ? { blockedReason } : {}),
      });
    };
    const killTree = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => child.kill("SIGKILL"));
        killer.on("exit", () => child.kill("SIGKILL"));
        const killTimer = setTimeout(() => killer.kill(), 1_000);
        killTimer.unref();
        killer.on("close", () => clearTimeout(killTimer));
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const stop = (reason: string) => {
      if (finished || blockedReason) return;
      blockedReason = reason;
      killTree();
      cleanupTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.kill("SIGKILL");
        finish(null);
      }, 1_000);
    };
    const onAbort = () => stop("Investigation aborted.");
    const timer = setTimeout(() => stop("Node test exceeded the 30000ms execution limit."), 29_000);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on("error", () => {
      blockedReason = "Unable to start fixed Node test runner.";
      finish(null);
    });
    child.on("exit", () => {
      // A exited parent with open descendant pipes must not hold the tool until its deadline.
      killTree();
    });
    child.on("close", (code) => finish(code));
  });
}

/** Read-only bounded inspection, plus one explicit, real Node test; never writes project files. */
export async function executeInvestigationTool(
  projectDir: string,
  request: InvestigationToolRequest,
  signal?: AbortSignal,
): Promise<object> {
  const tool = typeof request?.tool === "string" ? request.tool.slice(0, 40) : "unknown";
  const deadline = Date.now() + 5_000;
  const checkpoint = () => {
    if (signal?.aborted) throw new Error("Investigation aborted.");
    if (Date.now() >= deadline) throw new Error("Investigation inspection timed out.");
  };
  try {
    checkpoint();
    const parsed = investigationToolRequestSchema.safeParse(request);
    if (!parsed.success) throw new Error("Invalid investigation request.");
    const req = parsed.data;
    const root = await validateRoot(projectDir);
    checkpoint();
    if (req.tool === "read_file") {
      const relative = normalize(req.path);
      const { target } = await validatePath(root, relative, "file");
      const result = await readBounded(target, READ_LIMIT);
      checkpoint();
      const lines = result.text.split(/\r?\n/);
      let text = "";
      let count = 0;
      for (let index = req.offset - 1; index < lines.length && count < req.limit; index++) {
        const line = `${index + 1}: ${lines[index]}\n`;
        const remaining = OUTPUT_LIMIT - text.length;
        text += line.slice(0, remaining);
        count++;
        if (line.length > remaining || text.length >= OUTPUT_LIMIT) break;
      }
      return {
        tool,
        ok: true,
        path: relative,
        offset: req.offset,
        linesReturned: count,
        text,
        truncated:
          result.truncated || req.offset - 1 + count < lines.length || text.length >= OUTPUT_LIMIT,
      };
    }
    if (req.tool === "node_test") {
      const testPath = normalize(req.testPath);
      if (!/^tests\/(?:[^/]+\/)*[^/]+\.test\.(?:js|cjs|mjs)$/.test(testPath)) {
        throw new Error("Only one existing tests/**/*.test.js|cjs|mjs path is allowed.");
      }
      const { target: cwd } = await validatePath(root, req.directory, "directory");
      const { stat } = await validatePath(root, `${req.directory}/${testPath}`, "file");
      if (stat.size > 256_000) throw new Error("Test exceeds the 256000-byte limit.");
      checkpoint();
      return await runNodeTest(cwd, testPath, signal);
    }
    const relative = normalize(req.directory, true);
    await validatePath(root, relative, "directory");
    if (req.tool === "list_files") {
      const entries: { path: string; type: "file" | "directory" }[] = [];
      let seen = 0;
      let truncated = false;
      const dir = await fs.opendir(safeJoin(root, relative));
      for await (const entry of dir) {
        checkpoint();
        if (++seen > 1_000) {
          truncated = true;
          break;
        }
        if (
          protectedName(entry.name) ||
          entry.isSymbolicLink() ||
          (!entry.isFile() && !entry.isDirectory())
        )
          continue;
        const entryPath = relative === "." ? entry.name : `${relative}/${entry.name}`;
        normalize(entryPath);
        await validatePath(root, entryPath, entry.isDirectory() ? "directory" : "file");
        if (
          entries.length >= 200 ||
          JSON.stringify(entries).length + entryPath.length + 50 > OUTPUT_LIMIT
        ) {
          truncated = true;
          break;
        }
        entries.push({ path: entryPath, type: entry.isDirectory() ? "directory" : "file" });
      }
      return { tool, ok: true, directory: relative, entries, truncated };
    }
    const hits: { path: string; line: number; text: string }[] = [];
    let entries = 0;
    let bytes = 0;
    let outputSize = 0;
    let truncated = false;
    const walk = async (relativeDir: string, depth: number): Promise<void> => {
      if (depth > 20) {
        truncated = true;
        return;
      }
      const dir = await fs.opendir(safeJoin(root, relativeDir));
      for await (const entry of dir) {
        checkpoint();
        if (++entries > 1_000) {
          truncated = true;
          break;
        }
        if (protectedName(entry.name) || entry.isSymbolicLink()) continue;
        const entryPath = relativeDir === "." ? entry.name : `${relativeDir}/${entry.name}`;
        normalize(entryPath);
        if (entry.isDirectory()) {
          await validatePath(root, entryPath, "directory");
          await walk(entryPath, depth + 1);
        } else if (entry.isFile()) {
          const { target, stat } = await validatePath(root, entryPath, "file");
          if (stat.size > 128_000) {
            truncated = true;
            continue;
          }
          if (bytes + stat.size > 2_000_000) {
            truncated = true;
            break;
          }
          bytes += stat.size;
          let text: string;
          try {
            text = (await readBounded(target, 128_000)).text;
          } catch {
            continue;
          }
          const lines = text.split(/\r?\n/);
          for (let index = 0; index < lines.length; index++) {
            if (!lines[index].includes(req.query)) continue;
            const hit = { path: entryPath, line: index + 1, text: lines[index].slice(0, 300) };
            const size = JSON.stringify(hit).length;
            if (hits.length >= 100 || outputSize + size > OUTPUT_LIMIT) {
              truncated = true;
              break;
            }
            outputSize += size;
            hits.push(hit);
          }
        }
        if (
          entries > 1_000 ||
          bytes >= 2_000_000 ||
          hits.length >= 100 ||
          outputSize >= OUTPUT_LIMIT - 900
        ) {
          truncated = true;
          break;
        }
      }
    };
    await walk(relative, 0);
    checkpoint();
    return { tool, ok: true, query: req.query, directory: relative, hits, truncated };
  } catch (error) {
    const reason =
      error instanceof Error && !(error as NodeJS.ErrnoException).code
        ? error.message.slice(0, 300)
        : "Requested path cannot be safely inspected.";
    return { tool, ok: false, blockedReason: reason };
  }
}
