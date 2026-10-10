import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/server/auth";
import { assertProjectOwner } from "@/server/agents/context";
import { db } from "@/server/db";
import { buildKnowledgeOverview, buildDefenseKnowledgeText } from "@/server/defense/knowledge";
import {
  generateDefenseQuestions,
  generatePptOutline,
  scoreAnswer,
  generateDefenseReport,
  DefenseError,
  type AnswerScore,
} from "@/server/defense/agent";
import { AiNotConfiguredError } from "@/server/ai/provider";
import { logActivity } from "@/server/activity";
import { handleRouteError, jsonError } from "@/server/api-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Phase 10:答辩中心。
 * GET  ?resource=knowledge | overview
 * POST ?action=generate-questions | generate-ppt | start-session | answer | finish-session | clear-questions
 */

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.id) return jsonError(401, "unauthorized", "请先登录");
    await assertProjectOwner(id, session.user.id);

    const resource = new URL(request.url).searchParams.get("resource") ?? "overview";

    if (resource === "knowledge") {
      return NextResponse.json({ knowledge: await buildKnowledgeOverview(id, session.user.id) });
    }

    const [questions, sessions, materials] = await Promise.all([
      db.defenseQuestion.findMany({ where: { projectId: id }, orderBy: { createdAt: "asc" } }),
      db.defenseSession.findMany({
        where: { projectId: id },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { turns: { orderBy: { index: "asc" } } },
      }),
      db.defenseMaterial.findMany({ where: { projectId: id } }),
    ]);

    return NextResponse.json({
      questions: questions.map((q) => ({
        id: q.id,
        category: q.category,
        question: q.question,
        expectedPoints: safeJsonArray(q.expectedPoints),
        difficulty: q.difficulty,
        status: q.status,
      })),
      sessions: sessions.map((s) => ({
        id: s.id,
        status: s.status,
        overallScore: s.overallScore,
        summary: s.summary,
        ...parseStoredReport(s.weakPoints),
        createdAt: s.createdAt.toISOString(),
        finishedAt: s.finishedAt?.toISOString() ?? null,
        turns: s.turns.map((t) => ({
          id: t.id,
          index: t.index,
          question: t.question,
          category: t.category,
          isFollowup: t.isFollowup,
          answer: t.answer,
          scores: safeJsonObject(t.scores),
          comment: t.comment,
        })),
      })),
      ppt: materials.find((m) => m.kind === "ppt_outline")
        ? safeJsonObject(materials.find((m) => m.kind === "ppt_outline")!.content)
        : null,
    });
  } catch (error) {
    return handleRouteError("defense.get", error);
  }
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("generate-questions"),
    count: z.number().int().min(4).max(12).default(8),
    focus: z.string().max(100).optional(),
  }),
  z.object({ action: z.literal("generate-ppt") }),
  z.object({ action: z.literal("clear-questions") }),
  z.object({
    action: z.literal("start-session"),
    questionCount: z.number().int().min(1).max(10).default(5),
  }),
  z.object({
    action: z.literal("answer"),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    answer: z.string().max(8_000),
  }),
  z.object({ action: z.literal("finish-session"), sessionId: z.string().min(1) }),
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

    if (body.action === "generate-questions") {
      const knowledgeText = await buildDefenseKnowledgeText(id, session.user.id);
      const generated = await generateDefenseQuestions({
        knowledgeText,
        count: body.count,
        focus: body.focus,
      });
      await db.defenseQuestion.deleteMany({ where: { projectId: id, status: "pending" } });
      const rows = await db.defenseQuestion.createManyAndReturn({
        data: generated.map((q) => ({
          projectId: id,
          category: q.category,
          question: q.question,
          expectedPoints: JSON.stringify(q.expectedPoints),
          difficulty: q.difficulty,
        })),
      });
      await logActivity(id, "ai", `AI 生成答辩问题 ${rows.length} 个`);
      return NextResponse.json({ generated: rows.length });
    }

    if (body.action === "generate-ppt") {
      const knowledgeText = await buildDefenseKnowledgeText(id, session.user.id);
      const outline = await generatePptOutline(knowledgeText);
      await db.defenseMaterial.upsert({
        where: { projectId_kind: { projectId: id, kind: "ppt_outline" } },
        create: { projectId: id, kind: "ppt_outline", content: JSON.stringify(outline) },
        update: { content: JSON.stringify(outline) },
      });
      await logActivity(id, "ai", `AI 生成答辩 PPT 结构(${outline.slides.length} 页)`);
      return NextResponse.json({ ppt: outline });
    }

    if (body.action === "clear-questions") {
      await db.defenseQuestion.deleteMany({ where: { projectId: id, status: "pending" } });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "start-session") {
      const running = await db.defenseSession.findFirst({
        where: { projectId: id, status: "active" },
        select: { id: true },
      });
      if (running) return jsonError(409, "session_active", "已有进行中的模拟答辩,请先完成它");
      const pool = await db.defenseQuestion.findMany({
        where: { projectId: id, status: "pending" },
        orderBy: { createdAt: "asc" },
        take: body.questionCount,
      });
      if (pool.length === 0) {
        return jsonError(409, "no_questions", "题库为空,请先生成答辩问题");
      }
      const created = await db.defenseSession.create({
        data: { projectId: id, status: "active" },
      });
      await db.defenseTurn.createMany({
        data: pool.map((q, index) => ({
          sessionId: created.id,
          index,
          question: q.question,
          category: q.category,
        })),
      });
      // 题目标记为已用(会话结束时不再重复出现)
      await db.defenseQuestion.updateMany({
        where: { id: { in: pool.map((q) => q.id) } },
        data: { status: "answered" },
      });
      await logActivity(id, "ai", `发起模拟答辩(${pool.length} 题)`);
      const turns = await db.defenseTurn.findMany({
        where: { sessionId: created.id },
        orderBy: { index: "asc" },
      });
      return NextResponse.json(
        { session: { id: created.id, status: created.status }, turns: turns.map(toTurnDto) },
        { status: 201 },
      );
    }

    if (body.action === "answer") {
      const sess = await db.defenseSession.findFirst({
        where: { id: body.sessionId, projectId: id },
        include: { turns: { orderBy: { index: "asc" } } },
      });
      if (!sess) return jsonError(404, "not_found", "会话不存在");
      if (sess.status !== "active") return jsonError(409, "session_finished", "会话已结束");
      const turn = sess.turns.find((t) => t.id === body.turnId);
      if (!turn) return jsonError(404, "not_found", "问答不存在");
      if (turn.scores !== "{}") return jsonError(409, "already_answered", "该题已作答");

      const knowledgeText = await buildDefenseKnowledgeText(id, session.user.id);
      // 参考答案要点:从题库按问题文本反查(题目可能已被追问改写,查不到则空)
      const banked = await db.defenseQuestion.findFirst({
        where: { projectId: id, question: turn.question },
        select: { expectedPoints: true },
      });
      const score = await scoreAnswer({
        knowledgeText,
        question: turn.question,
        category: turn.category,
        expectedPoints: banked ? safeJsonArray(banked.expectedPoints) : [],
        answer: body.answer,
        isFollowup: turn.isFollowup,
      });
      await db.defenseTurn.update({
        where: { id: turn.id },
        data: {
          answer: body.answer,
          scores: JSON.stringify(score),
          comment: score.comment,
        },
      });

      // 追问:主问题且评委给出追问 → 追加一问(在下一 index)
      let followupTurn = null;
      if (score.followup && !turn.isFollowup) {
        const maxIndex = sess.turns.length;
        const ft = await db.defenseTurn.create({
          data: {
            sessionId: sess.id,
            index: maxIndex,
            question: score.followup.question,
            category: turn.category,
            isFollowup: true,
          },
        });
        followupTurn = toTurnDto(ft);
      }

      const nextTurn = await nextPendingTurn(sess.id);
      return NextResponse.json({
        scores: score,
        followupTurn,
        nextTurn,
        finished: !nextTurn && !followupTurn,
      });
    }

    if (body.action === "finish-session") {
      const sess = await db.defenseSession.findFirst({
        where: { id: body.sessionId, projectId: id },
        include: { turns: { orderBy: { index: "asc" } } },
      });
      if (!sess) return jsonError(404, "not_found", "会话不存在");
      if (sess.status === "finished") return jsonError(409, "session_finished", "会话已结束");

      const answered = sess.turns.filter((t) => t.scores !== "{}");
      if (answered.length === 0) {
        return jsonError(409, "no_answers", "还没有作答记录,无法生成评估报告");
      }
      const knowledgeText = await buildDefenseKnowledgeText(id, session.user.id);
      const report = await generateDefenseReport({
        knowledgeText,
        turns: sess.turns.map((t) => ({
          question: t.question,
          category: t.category,
          isFollowup: t.isFollowup,
          answer: t.answer,
          scores: t.scores === "{}" ? null : (safeJsonObject(t.scores) as AnswerScore),
        })),
      });
      await db.defenseSession.update({
        where: { id: sess.id },
        data: {
          status: "finished",
          overallScore: report.readiness,
          summary: report.summary,
          weakPoints: JSON.stringify({
            weakPoints: report.weakPoints,
            dimensions: report.dimensions,
          }),
          finishedAt: new Date(),
        },
      });
      await logActivity(id, "ai", `模拟答辩完成,准备度 ${report.readiness} 分`);
      return NextResponse.json({ report });
    }

    return jsonError(400, "invalid_action", "action 不合法");
  } catch (error) {
    if (error instanceof DefenseError) {
      return jsonError(500, error.code, error.message);
    }
    if (error instanceof AiNotConfiguredError) {
      return jsonError(503, "ai_not_configured", "尚未配置 AI Provider");
    }
    return handleRouteError("defense.post", error);
  }
}

async function nextPendingTurn(sessionId: string) {
  const turns = await db.defenseTurn.findMany({
    where: { sessionId },
    orderBy: { index: "asc" },
  });
  const pending = turns.find((t) => t.scores === "{}");
  return pending ? toTurnDto(pending) : null;
}

function toTurnDto(t: {
  id: string;
  index: number;
  question: string;
  category: string;
  isFollowup: boolean;
  answer: string;
  scores: string;
  comment: string;
}) {
  return {
    id: t.id,
    index: t.index,
    question: t.question,
    category: t.category,
    isFollowup: t.isFollowup,
    answer: t.answer,
    scores: safeJsonObject(t.scores),
    comment: t.comment,
  };
}

/** 会话存的报告数据:新格式 {weakPoints, dimensions};旧格式是纯数组。 */
function parseStoredReport(raw: string): {
  weakPoints: Array<Record<string, unknown>>;
  dimensions: Array<Record<string, unknown>>;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as { weakPoints?: unknown; dimensions?: unknown };
      return {
        weakPoints: Array.isArray(obj.weakPoints)
          ? (obj.weakPoints as Array<Record<string, unknown>>)
          : [],
        dimensions: Array.isArray(obj.dimensions)
          ? (obj.dimensions as Array<Record<string, unknown>>)
          : [],
      };
    }
    if (Array.isArray(parsed)) {
      return { weakPoints: parsed as Array<Record<string, unknown>>, dimensions: [] };
    }
  } catch {
    /* fallthrough */
  }
  return { weakPoints: [], dimensions: [] };
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
