import { generationBatchesForPlan } from "./generation-efficiency";

/** Never infer timeout from arbitrary provider text, cancellation, or a project wall budget. */
export function isGenerationTimeout(error: unknown): boolean {
  if (error instanceof Error)
    return error.name === "AiRequestTimeoutError" || error.name === "TimeoutError";
  // Historical checkpoints only stored the normalized coding-agent error message.
  return (
    typeof error === "string" &&
    (/^AI 生成超时[,，;；]/.test(error) ||
      /^AI 请求超时/.test(error) ||
      /^模型请求超时/.test(error) ||
      /^The operation was aborted due to timeout$/.test(error))
  );
}

export type GenerationOutputFailureKind = "json" | "schema" | "length";

/** Runtime failures need the compat type marker, never merely provider/message text. */
export function generationOutputFailureKind(error: unknown): GenerationOutputFailureKind | null {
  if (error instanceof Error) {
    const typed = error.name === "CodingAgentError" ? error.cause : error;
    if (!(typed instanceof Error) || typed.name !== "AiOutputFormatError") return null;
    const kind = (typed as Error & { kind?: unknown }).kind;
    return kind === "json" || kind === "schema" || kind === "length" ? kind : null;
  }
  // Historical checkpoints store only coding-agent/compat messages. Keep this allowlist narrow.
  if (typeof error !== "string") return null;
  if (
    /^(?:AI 调用失败:)?AI 输出(?:未找到可解析的完整 JSON 对象|包含多个符合 JSON Schema 的完整根对象|还包含未闭合的 JSON 根块)/.test(
      error,
    )
  )
    return "json";
  if (/^(?:AI 调用失败:)?AI 输出\s*JSON Schema 校验失败/.test(error)) return "schema";
  if (/^(?:AI 调用失败:)?模型或上游服务报告长度截断/.test(error)) return "length";
  return null;
}

export function isRecoverableGenerationFailure(error: unknown): boolean {
  return isGenerationTimeout(error) || generationOutputFailureKind(error) !== null;
}

export function generationBatchKey(indices: readonly number[]): string {
  return `files-${indices.join("-")}`;
}

type RecoveryState = {
  currentPlan: { steps: Parameters<typeof generationBatchesForPlan>[0] } | null;
  generationBatches?: number[][];
  generationBatchKeys?: string[];
  batchCursor: number;
  pendingChangeSetId: string | null;
  batchRecovery?: { moduleId: string; attempts: string[] };
};

/** Pure durable transition; callers prove generation failed before any pending/applying writes. */
export function splitFailedGenerationBatch(state: RecoveryState, moduleId: string): boolean {
  if (!state.currentPlan || state.pendingChangeSetId) return false;
  const batches = generationBatchesForPlan(state.currentPlan.steps, state.generationBatches);
  const current = batches[state.batchCursor];
  if (!current || current.length <= 1) return false;
  const key = generationBatchKey(current);
  const attempts = state.batchRecovery?.moduleId === moduleId ? state.batchRecovery.attempts : [];
  if (attempts.includes(key)) return false;
  const midpoint = Math.ceil(current.length / 2);
  const halves = [current.slice(0, midpoint), current.slice(midpoint)];
  // Completed legacy keys stay intact. Every unfinished key becomes file-index based,
  // so shifting suffix cursors cannot reconcile an old record for a different slice.
  const keys = batches.map((batch, cursor) =>
    cursor < state.batchCursor
      ? (state.generationBatchKeys?.[cursor] ?? String(cursor))
      : generationBatchKey(batch),
  );
  batches.splice(state.batchCursor, 1, ...halves);
  keys.splice(state.batchCursor, 1, ...halves.map(generationBatchKey));
  state.generationBatches = batches;
  state.generationBatchKeys = keys;
  // Remember only the replaced parent; smaller children may split until single-file.
  state.batchRecovery = {
    moduleId,
    attempts: [...new Set([...attempts, key])],
  };
  return true;
}

// Retain the established API for timeout-only callers.
export const splitTimedOutGenerationBatch = splitFailedGenerationBatch;

export function generationFailureDiagnostic(error: unknown, fileCount: number): string {
  if (isGenerationTimeout(error)) return generationTimeoutDiagnostic(fileCount);
  const kind = generationOutputFailureKind(error);
  const reason =
    kind === "length"
      ? "长度截断"
      : kind === "schema"
        ? "JSON Schema 校验失败"
        : "JSON 输出不完整或无法解析";
  const typed = error instanceof Error && error.name === "CodingAgentError" ? error.cause : error;
  const evidence =
    typed instanceof Error && typed.name === "AiOutputFormatError" ? `\n${typed.message}` : "";
  return `AI ${fileCount <= 1 ? "单文件" : "批次"}生成${reason}；当前批次已无法安全继续拆分，未创建或应用本批次变更，已保留检查点。已停止自动重试，请检查模型输出或服务后再继续。${evidence}`;
}

export function generationTimeoutDiagnostic(fileCount: number): string {
  return fileCount <= 1
    ? "AI 单文件生成请求超时；未创建或应用本批次变更，已保留检查点。本次等待结束，可直接从断点继续重试，无需自行拆分文件；若持续超时请检查网关响应。"
    : "AI 批次生成请求超时；当前批次无法安全继续拆分，未创建或应用变更，已保留检查点。请检查模型服务后再继续。";
}
