import { NextResponse } from "next/server";
import { AiNotConfiguredError } from "@/server/ai/provider";
import { AiGenerationError } from "@/server/ai/generate";
import { ArchitectAgentError } from "@/server/agents/architect-agent";
import { CodingAgentError } from "@/server/agents/coding-agent";
import { RequirementAccessError, RequirementConflictError } from "@/server/requirements";

interface ErrorPayload {
  error: { code: string; message: string };
}

export function jsonError(
  status: number,
  code: string,
  message: string,
): NextResponse<ErrorPayload> {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** 将服务层/AI 层异常统一转为 HTTP 响应;未知异常记录日志并返回 500。 */
export function handleRouteError(scope: string, error: unknown): NextResponse<ErrorPayload> {
  if (error instanceof AiNotConfiguredError) {
    return jsonError(503, "ai_not_configured", error.message);
  }
  if (
    error instanceof AiGenerationError ||
    error instanceof ArchitectAgentError ||
    error instanceof CodingAgentError
  ) {
    return jsonError(502, "ai_generation_failed", error.message);
  }
  if (error instanceof RequirementAccessError) {
    return jsonError(404, "not_found", error.message);
  }
  if (error instanceof RequirementConflictError) {
    return jsonError(409, "conflict", error.message);
  }
  console.error(`[api:${scope}]`, error);
  return jsonError(500, "internal", "服务器内部错误,请稍后重试");
}

export async function requireUserId(): Promise<string | null> {
  const { auth } = await import("@/server/auth");
  const session = await auth();
  return session?.user?.id ?? null;
}
