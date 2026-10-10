import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import {
  ensureRepo,
  getStatus,
  listCommits,
  getDiff,
  commitAll,
  createBranch,
  checkoutBranch,
  rollbackToCommit,
  restoreFileFromCommit,
  GitError,
} from "@/server/git";
import { generateCommitMessage } from "@/server/git-ai";
import { AiNotConfiguredError } from "@/server/ai/provider";
import { logActivity } from "@/server/activity";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

/**
 * Phase 8:本地版本管理。
 * GET  ?resource=status | commits | diff
 * POST ?action=commit | branch | checkout | rollback | restore-file | ai-message
 */

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");
    await assertProjectOwner(id, session.user.id);

    const url = new URL(request.url);
    const resource = url.searchParams.get("resource") ?? "status";

    if (resource === "status") {
      const result = await ensureRepo(id);
      if (result.created) {
        await logActivity(
          id,
          "system",
          "初始化 Git 仓库",
          result.initialCommit ? "已创建基线提交" : "工作区为空,暂无基线提交",
        );
      }
      const status = await getStatus(id);
      return NextResponse.json({ status });
    }

    if (resource === "commits") {
      const limit = Number(url.searchParams.get("limit") ?? "50") || 50;
      const commits = await listCommits(id, Math.min(limit, 100));
      return NextResponse.json({ commits });
    }

    if (resource === "diff") {
      const hash = url.searchParams.get("hash") ?? "WORKING";
      const files = await getDiff(id, hash);
      return NextResponse.json({ files });
    }

    return jsonError(400, "invalid_resource", "resource 必须是 status|commits|diff");
  } catch (error) {
    return handleGitError("git.get", error);
  }
}

const actionSchema = z.union([
  z.object({
    action: z.literal("commit"),
    message: z.string().trim().min(2, "提交信息太短").max(2000),
  }),
  z.object({ action: z.literal("branch"), name: z.string().trim().min(1).max(60) }),
  z.object({ action: z.literal("checkout"), name: z.string().trim().min(1).max(60) }),
  z.object({ action: z.literal("rollback"), hash: z.string().trim().min(7).max(40) }),
  z.object({
    action: z.literal("restore-file"),
    hash: z.string().trim().min(4).max(40),
    path: z.string().trim().min(1).max(500),
  }),
  z.object({
    action: z.literal("ai-message"),
    taskTitle: z.string().max(200).optional(),
    taskSummary: z.string().max(1000).optional(),
  }),
]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");
    await assertProjectOwner(id, session.user.id);

    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "invalid_input", parsed.error.issues[0]?.message ?? "输入不合法");
    }
    const body = parsed.data;

    if (body.action === "commit") {
      const result = await commitAll(id, body.message);
      await logActivity(
        id,
        "file",
        `Git 提交 ${result.shortHash}:${body.message.split("\n")[0].slice(0, 60)}`,
        `${result.files} 个文件`,
      );
      return NextResponse.json({ commit: result });
    }

    if (body.action === "branch") {
      const result = await createBranch(id, body.name);
      await logActivity(id, "system", `创建并切换分支 ${result.branch}`);
      return NextResponse.json({ branch: result.branch });
    }

    if (body.action === "checkout") {
      const result = await checkoutBranch(id, body.name);
      await logActivity(id, "system", `切换到分支 ${result.branch}`);
      return NextResponse.json({ branch: result.branch });
    }

    if (body.action === "rollback") {
      const result = await rollbackToCommit(id, body.hash);
      await logActivity(
        id,
        "system",
        `回滚到版本 ${result.shortHash}`,
        `当前进度已备份到分支 ${result.backupBranch},可随时切回`,
      );
      return NextResponse.json({ rollback: result });
    }

    if (body.action === "restore-file") {
      const result = await restoreFileFromCommit(id, body.hash, body.path);
      await logActivity(id, "file", `从 ${body.hash.slice(0, 7)} 恢复文件 ${result.path}`);
      return NextResponse.json({ restored: result });
    }

    if (body.action === "ai-message") {
      try {
        const message = await generateCommitMessage({
          projectId: id,
          taskContext:
            body.taskTitle || body.taskSummary
              ? { title: body.taskTitle ?? "开发任务", summary: body.taskSummary ?? "" }
              : undefined,
        });
        return NextResponse.json({ message: message.message, body: message.body });
      } catch (error) {
        if (error instanceof AiNotConfiguredError) {
          return jsonError(503, "ai_not_configured", "尚未配置 AI Provider");
        }
        return handleGitError("git.ai-message", error);
      }
    }

    return jsonError(400, "invalid_action", "action 不合法");
  } catch (error) {
    return handleGitError("git.post", error);
  }
}

function handleGitError(scope: string, error: unknown) {
  if (error instanceof GitError) {
    const status =
      error.code === "nothing_to_commit" || error.code === "already_at_commit" ? 409 : 400;
    return jsonError(status, error.code, error.message);
  }
  return handleRouteError(scope, error);
}
