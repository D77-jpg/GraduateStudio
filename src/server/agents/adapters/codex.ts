import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import { CodexJsonlParser, safeCodexDiagnostic } from "./codex-jsonl";
import type {
  AgentEngine,
  AgentEngineEvent,
  AgentEngineResult,
  AgentEngineTask,
  CodexSpawn,
} from "../engine";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const KILL_GRACE_MS = 1000;

function codexCommand(): string {
  const configured = process.env.CODEX_BIN?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      const binary = path.join(
        directory.replace(/^"|"$/g, ""),
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        "x86_64-pc-windows-msvc",
        "bin",
        "codex.exe",
      );
      if (existsSync(binary)) return binary;
    }
    throw new Error("未找到 Codex 原生可执行文件；请设置 CODEX_BIN 为 codex.exe 的绝对路径。");
  }
  return "codex";
}

function safePrompt(task: AgentEngineTask): string {
  const allowed = task.allowedPaths?.length
    ? task.allowedPaths.join(", ")
    : "(按项目需求判断，但不得越过工作区根目录)";
  const forbidden = task.forbiddenPaths?.length
    ? task.forbiddenPaths.join(", ")
    : "(无额外禁止路径)";
  return [
    "你正在 GraduateStudio 管理的项目工作区中执行任务。",
    `任务目标：${task.prompt}`,
    `允许修改路径：${allowed}`,
    `禁止修改路径：${forbidden}`,
    "只在工作区内操作；不要读取或输出密钥、令牌、.env 内容。严格遵循任务指定的结果格式；要求 JSON 时只返回 JSON，不要 Markdown 或额外总结。",
    "Windows 编码硬约束：每条 PowerShell 命令先设置 [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding。读取文本必须 Get-Content -Encoding UTF8，写文本必须显式 UTF8，禁止依赖系统默认 ANSI 编码。也可用 Node fs.readFileSync(path, 'utf8') 读取，不得把乱码重新写回源文件。",
  ].join("\n");
}

interface ActiveRun {
  stop: (message: string, exitCode: number) => void;
  closed: Promise<void>;
}

export class CodexEngine implements AgentEngine {
  readonly id = "codex" as const;
  private readonly children = new Map<string, ActiveRun>();
  constructor(
    private readonly spawnProcess?: CodexSpawn,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  private nativeSpawn: CodexSpawn = (command, args, options) =>
    spawn(command, args, {
      cwd: options.cwd,
      // The adapter owns cancellation so AbortSignal cannot bypass tree cleanup.
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

  async run(
    task: AgentEngineTask,
    onEvent?: (event: AgentEngineEvent) => void,
  ): Promise<AgentEngineResult> {
    const runId = crypto.randomUUID();
    // A consumer callback must not break stream draining or process cleanup.
    const emit = (event: AgentEngineEvent) => {
      try {
        onEvent?.(event);
      } catch {
        /* observer failure */
      }
    };
    const result = (exitCode: number, parser?: CodexJsonlParser): AgentEngineResult => ({
      runId,
      engine: this.id,
      exitCode,
      threadId: parser?.threadId ?? null,
      lastMessage: parser?.lastMessage ?? "",
      changedPaths: [],
      violations: [],
    });
    emit({ type: "run.started", runId, engine: this.id });
    if (task.signal?.aborted) {
      emit({ type: "run.failed", runId, exitCode: 130, message: "Codex execution cancelled." });
      return result(130);
    }
    const args = [
      "--ask-for-approval",
      "never",
      "-c",
      "mcp_servers.cnki-search.enabled=false",
      "-c",
      "mcp_servers.node_repl.enabled=false",
      "-c",
      "mcp_servers.cua_repl.enabled=false",
      "-c",
      "features.js_repl=false",
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      task.mode === "read-only" ? "read-only" : "workspace-write",
      "--cd",
      path.resolve(task.workspace),
      safePrompt(task),
    ];
    let child: ChildProcess;
    try {
      child = (this.spawnProcess ?? this.nativeSpawn)(
        this.spawnProcess ? "codex" : codexCommand(),
        args,
        { cwd: path.resolve(task.workspace) },
      );
    } catch {
      emit({
        type: "run.failed",
        runId,
        exitCode: 1,
        message: "Unable to start Codex; check CODEX_BIN and CLI installation.",
      });
      return result(1);
    }
    return new Promise<AgentEngineResult>((resolve) => {
      const parser = new CodexJsonlParser(runId, emit);
      let stopped: { message: string; exitCode: number } | undefined;
      let spawnError = false;
      let stderrBytes = 0;
      // Keep only a fixed diagnostic prefix, never publish raw CLI stderr.
      let stderr = Buffer.alloc(0);
      let closed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const killers: Promise<void>[] = [];
      let closeResolve!: () => void;
      const closedPromise = new Promise<void>((done) => {
        closeResolve = done;
      });
      const killTree = (force: boolean) => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          try {
            const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
              windowsHide: true,
              stdio: "ignore",
            });
            killers.push(
              new Promise<void>((done) => {
                killer.once("error", () => {
                  try {
                    child.kill("SIGKILL");
                  } catch {
                    /* already gone */
                  }
                });
                killer.once("close", (code) => {
                  if (code !== 0) {
                    try {
                      child.kill("SIGKILL");
                    } catch {
                      /* already gone */
                    }
                  }
                  done();
                });
              }),
            );
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }
        } else {
          try {
            process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
          } catch {
            try {
              child.kill(force ? "SIGKILL" : "SIGTERM");
            } catch {
              /* already gone */
            }
          }
        }
      };
      const stop = (message: string, exitCode: number) => {
        if (closed || stopped) return;
        stopped = { message, exitCode };
        killTimer = setTimeout(() => killTree(true), KILL_GRACE_MS);
        killTimer.unref?.();
        killTree(false);
      };
      const abort = () => stop("Codex execution cancelled.", 130);
      this.children.set(runId, { stop, closed: closedPromise });
      task.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => stop("Codex execution timed out; process tree terminated.", 124),
        this.timeoutMs,
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stopped) return;
        parser.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (parser.failure) stop(parser.failure, 1);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stopped) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += bytes.length;
        if (stderr.length < 4096)
          stderr = Buffer.concat([stderr, bytes.subarray(0, 4096 - stderr.length)]);
        if (stderrBytes > 1024 * 1024) stop("Codex stderr exceeded its byte limit.", 1);
      });
      child.stdout?.on("error", () => stop("Codex stdout stream failed.", 1));
      child.stderr?.on("error", () => stop("Codex stderr stream failed.", 1));
      child.once("error", () => {
        spawnError = true;
        stop("Unable to start Codex; check CODEX_BIN and CLI installation.", 1);
      });
      // exit is intentionally NOT terminal: pipes and descendants may still be open.
      child.once("close", async (code: number | null, signal: NodeJS.Signals | null) => {
        closed = true;
        clearTimeout(timer);
        if (killTimer) {
          clearTimeout(killTimer);
          // The leader may have exited on TERM while descendants ignored it.
          if (process.platform !== "win32") killTree(true);
        }
        await Promise.all(killers);
        task.signal?.removeEventListener("abort", abort);
        this.children.delete(runId);
        parser.end();
        let exitCode = stopped?.exitCode ?? code ?? 1;
        let message = stopped?.message ?? parser.failure ?? undefined;
        if (code !== 0 && !stopped && parser.failure) {
          // A crash can interrupt the final JSON write. Preserve the native exit
          // and safe stderr category instead of blaming only the trailing frame.
          message = `Codex process exited with code ${code ?? "unknown"}. ${safeCodexDiagnostic(stderr.toString("utf8"))} ${parser.failure}`;
        }
        if (!message && (spawnError || code !== 0 || signal))
          message = `Codex process exited ${signal ? `with signal ${signal}` : `with code ${code ?? "unknown"}`}. ${stderr.length ? safeCodexDiagnostic(stderr.toString("utf8")) : "Check CLI installation, authentication and configuration."}`;
        if (!message && !parser.completed)
          message = "Codex stream ended without terminal turn.completed; output is incomplete.";
        if (message) {
          if (exitCode === 0) exitCode = 1;
          emit({ type: "run.failed", runId, exitCode, message });
        } else emit({ type: "run.completed", runId, exitCode });
        closeResolve();
        resolve(result(exitCode, parser));
      });
      // Covers an abort occurring during the synchronous spawn call.
      if (task.signal?.aborted) abort();
    });
  }

  async cancel(runId: string): Promise<void> {
    const active = this.children.get(runId);
    if (!active) return;
    active.stop("Codex execution cancelled.", 130);
    await active.closed;
  }
}
