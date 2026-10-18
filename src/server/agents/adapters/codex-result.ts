import { z } from "zod";
import { implementOutputSchema, type ChangeAction } from "@/lib/develop";
import type { AgentEngineResult } from "../engine";

/** Codex must return the same complete-file proposal contract as the existing AI adapter. */
export const codexImplementationResultSchema = implementOutputSchema;

export function parseCodexImplementationResult(
  result: AgentEngineResult,
): z.infer<typeof implementOutputSchema> {
  if (result.exitCode !== 0)
    throw new Error(
      `Codex 执行失败(exit ${result.exitCode})${result.lastMessage ? `: ${result.lastMessage}` : ""}`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.lastMessage);
  } catch {
    throw new Error("Codex 未返回合法的实现 JSON");
  }
  const checked = codexImplementationResultSchema.safeParse(parsed);
  if (!checked.success)
    throw new Error(
      `Codex 实现结果不符合完整文件契约: ${checked.error.issues[0]?.message ?? "未知错误"}`,
    );
  return checked.data;
}

export function changedPathsFromProposal(result: z.infer<typeof implementOutputSchema>): string[] {
  return result.changes.map((change: { action: ChangeAction; path: string }) => change.path);
}
