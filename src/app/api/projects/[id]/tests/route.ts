import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import {
  generateTests,
  runTests,
  listRuns,
  analyzeFailures,
  fixFailures,
  TestingError,
} from "@/server/testing";
import { TEST_KINDS, type TestKind } from "@/lib/testing";
import { db } from "@/server/db";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TEST_KIND_SET = new Set<string>(TEST_KINDS);

function parseKind(raw: string | null): TestKind {
  return (TEST_KIND_SET.has(raw ?? "") ? raw : "unit") as TestKind;
}

/**
 * 测试中心统一入口:
 * GET  ?view=runs              历史列表
 * POST ?action=generate {kind}          AI 生成测试
 * POST ?action=run      {kind}          执行测试
 * POST ?action=analyze  {runId}         AI 失败分析
 * POST ?action=fix      {runId, resultId?}  AI 修复 + 回归
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");

    await assertProjectOwner(id, session.user.id);
    const runs = await listRuns(id, session.user.id);
    return NextResponse.json({ runs });
  } catch (error) {
    return handleRouteError("tests.list", error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");
    const userId = session.user.id;

    await assertProjectOwner(id, userId);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") ?? "";

    if (action === "generate") {
      const body = z
        .object({ kind: z.enum(TEST_KINDS).default("unit") })
        .safeParse(await request.json().catch(() => ({})));
      const kind = parseKind(body.success ? body.data.kind : "unit");
      const result = await generateTests(id, userId, kind);
      return NextResponse.json({
        notes: result.notes,
        files: result.files.map((f) => f.path),
        installed: result.installed,
      });
    }

    if (action === "run") {
      const body = z
        .object({ kind: z.enum(TEST_KINDS).default("unit") })
        .safeParse(await request.json().catch(() => ({})));
      const kind = parseKind(body.success ? body.data.kind : "unit");
      const run = await runTests(id, userId, kind);
      return NextResponse.json({ run });
    }

    if (action === "analyze") {
      const body = z.object({ runId: z.string().min(1) }).safeParse(await request.json());
      if (!body.success) return jsonError(400, "invalid_input", "缺少 runId");
      const run = await analyzeFailures(id, userId, body.data.runId);
      return NextResponse.json({ run });
    }

    if (action === "ignore") {
      const body = z
        .object({ runId: z.string().min(1), resultId: z.string().min(1) })
        .safeParse(await request.json());
      if (!body.success) return jsonError(400, "invalid_input", "缺少 runId/resultId");
      await assertProjectOwner(id, userId);
      const owned = await db.testResult.findFirst({
        where: { id: body.data.resultId, run: { id: body.data.runId, projectId: id } },
        select: { id: true },
      });
      if (!owned) return jsonError(404, "not_found", "用例不存在");
      await db.testResult.update({ where: { id: body.data.resultId }, data: { ignored: true } });
      return NextResponse.json({ ok: true });
    }

    if (action === "fix") {
      const body = z
        .object({ runId: z.string().min(1), resultId: z.string().min(1).optional() })
        .safeParse(await request.json());
      if (!body.success) return jsonError(400, "invalid_input", "缺少 runId");
      const result = await fixFailures(id, userId, body.data.runId, body.data.resultId);
      return NextResponse.json(result);
    }

    return jsonError(400, "invalid_action", "action 必须是 generate|run|analyze|fix");
  } catch (error) {
    if (error instanceof TestingError) {
      const status =
        error.code === "not_found"
          ? 404
          : error.code === "no_project" || error.code === "no_tests"
            ? 409
            : 500;
      return jsonError(status, error.code, error.message);
    }
    return handleRouteError("tests.action", error);
  }
}
