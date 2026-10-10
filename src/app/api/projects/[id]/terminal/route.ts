import { NextResponse } from "next/server";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { ensureProjectDir } from "@/server/workspace/paths";
import { logActivity, listActivityLogs } from "@/server/activity";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 150;

const execAsync = promisify(exec);

const MAX_OUTPUT_CHARS = 30_000;
const TIMEOUT_MS = 120_000;
// 高危命令直接拒绝,防误操作(格式化删除/关机/跨盘清理)
const BLOCKED_PATTERNS = [
  /rm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*/i,
  /rmdir\s+\/s/i,
  /rd\s+\/s/i,
  /del\s+\/[qs]/i,
  /format\s+[a-z]:/i,
  /shutdown/i,
  /:\(\)\{.*\};:/,
  /Remove-Item\s+.*-Recurse\s+.*-Force/i,
];

/** 执行终端命令(cwd = 项目工作区;同步执行,120 秒超时)。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const parsed = z
      .object({ command: z.string().trim().min(1, "命令不能为空").max(500) })
      .safeParse(await request.json());
    if (!parsed.success) return jsonError(400, "invalid_input", "命令不合法");

    const command = parsed.data.command;
    if (BLOCKED_PATTERNS.some((pattern) => pattern.test(command))) {
      return jsonError(400, "blocked_command", "该命令被安全策略禁止(删除/格式化/关机类)");
    }

    const cwd = ensureProjectDir(id);
    const startedAt = Date.now();
    let exitCode: number | null = 0;
    let timedOut = false;
    let output = "";

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      });
      output = [stdout, stderr].filter(Boolean).join("\n");
    } catch (error) {
      const err = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        message?: string;
      };
      exitCode = typeof err.code === "number" ? err.code : 1;
      timedOut = Boolean(err.killed);
      output = [err.stdout, err.stderr, timedOut ? "(命令超时被终止)" : err.message]
        .filter(Boolean)
        .join("\n");
    }
    if (output.length > MAX_OUTPUT_CHARS)
      output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n…(输出过长已截断)`;

    const durationMs = Date.now() - startedAt;
    await logActivity(
      id,
      "terminal",
      `$ ${command}`,
      `exit=${exitCode ?? "n/a"} · ${(durationMs / 1000).toFixed(1)}s\n${output.slice(0, 1000)}`,
    );

    return NextResponse.json({
      run: { command, exitCode, timedOut, output, durationMs, cwd: path.basename(cwd) },
    });
  } catch (error) {
    return handleRouteError("terminal.run", error);
  }
}

/** 终端历史(取 terminal 类活动日志)。 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const logs = await listActivityLogs(id, session.user.id, 100);
    return NextResponse.json({ logs });
  } catch (error) {
    return handleRouteError("terminal.logs", error);
  }
}
