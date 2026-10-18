import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import {
  acceptChangeSet,
  ChangeSetAccessError,
  ChangeSetStateError,
  listChangeSets,
  rejectChangeSet,
  restoreChangeSet,
  undoLatestChangeSet,
} from "@/server/changesets";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";

function changesetRouteError(scope: string, error: unknown) {
  if (error instanceof ChangeSetAccessError) return jsonError(404, "not_found", error.message);
  if (error instanceof ChangeSetStateError) return jsonError(409, "conflict", error.message);
  return handleRouteError(scope, error);
}

/** 变更集历史 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const changeSets = await listChangeSets(id, session.user.id);
    return NextResponse.json({ changeSets });
  } catch (error) {
    return changesetRouteError("changesets.list", error);
  }
}

/** 变更集操作:{ action: accept | reject | undo } */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const body = z
      .object({ action: z.enum(["accept", "reject", "undo"]), changeSetId: z.string().optional() })
      .safeParse(await request.json());
    if (!body.success) return jsonError(400, "invalid_input", "action 不合法");

    let changeSet;
    if (body.data.action === "undo") {
      changeSet = await undoLatestChangeSet(id, session.user.id);
    } else {
      if (!body.data.changeSetId) return jsonError(400, "invalid_input", "缺少 changeSetId");
      changeSet =
        body.data.action === "accept"
          ? await acceptChangeSet(body.data.changeSetId, session.user.id, id)
          : await rejectChangeSet(body.data.changeSetId, session.user.id, id);
    }
    let verification: string | null = null;
    if (body.data.action === "accept") {
      // Acceptance is an explicit write action; GET polling never starts work.
      try {
        const { db } = await import("@/server/db");
        const { loadCodexCheckpoint } = await import("@/server/agents/codex-checkpoint");
        const { reconcileCodexReview } = await import("@/server/agents/codex-review");
        const { startCodexPostApplyVerification } =
          await import("@/server/agents/codex-post-apply");
        const tasks = await db.agentTask.findMany({
          where: { projectId: id, status: { in: ["paused", "checking"] } },
          select: { id: true },
        });
        for (const task of tasks) {
          const cp = await loadCodexCheckpoint(id, task.id);
          if (cp?.pendingChangeSetId !== changeSet.id) continue;
          await reconcileCodexReview(id, task.id);
          await startCodexPostApplyVerification(id, task.id, session.user.id);
          verification = "started";
          break;
        }
      } catch {
        // Files have already been accepted: never misreport acceptance as failed.
        verification = "not_started";
      }
    }
    return NextResponse.json({ changeSet, verification });
  } catch (error) {
    return changesetRouteError("changesets.action", error);
  }
}

/** 恢复被撤销的变更集:{ changeSetId } */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    const body = z.object({ changeSetId: z.string().min(1) }).safeParse(await request.json());
    if (!body.success) return jsonError(400, "invalid_input", "缺少 changeSetId");

    const changeSet = await restoreChangeSet(body.data.changeSetId, session.user.id, id);
    return NextResponse.json({ changeSet });
  } catch (error) {
    return changesetRouteError("changesets.restore", error);
  }
}
