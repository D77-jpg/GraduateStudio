import { z } from "zod";
import { generateObjectCompat } from "@/server/ai/compat";
import { getDiff, GitError } from "@/server/git";

/**
 * Phase 8:AI 生成 Conventional Commits 风格提交信息。
 * 输入是当前工作区 diff(或指定提交的上下文),输出单行标题 + 可选正文。
 */

const commitMessageSchema = z.object({
  message: z
    .string()
    .min(6)
    .max(80)
    .describe("Conventional Commits 单行标题,如 feat: implement user authentication"),
  body: z.string().max(600).describe("提交正文:修改了什么、为什么;多行用 \\n 分隔;没有则空字符串"),
});

export interface GeneratedCommitMessage {
  message: string;
  body: string;
}

/** 基于工作区变更生成提交信息。diff 为空时抛出 AiNotConfiguredError 以外的错误由调用方兜底。 */
export async function generateCommitMessage(input: {
  projectId: string;
  taskContext?: { title: string; summary: string; testSummary?: string };
}): Promise<GeneratedCommitMessage> {
  const files = await getDiff(input.projectId, "WORKING");
  if (files.length === 0) {
    throw new GitError("工作区没有变更,无法生成提交信息", "nothing_to_commit");
  }

  const statLines = files
    .slice(0, 40)
    .map((f) => `- ${f.path} (+${f.additions} -${f.deletions})`)
    .join("\n");
  const patchExcerpt = files
    .slice(0, 6)
    .map((f) => `--- ${f.path} ---\n${f.patch.slice(0, 1500)}`)
    .join("\n\n");

  const taskPart = input.taskContext
    ? `\n## 本次任务\n标题:${input.taskContext.title}\n摘要:${input.taskContext.summary}${
        input.taskContext.testSummary ? `\n测试:${input.taskContext.testSummary}` : ""
      }\n`
    : "";

  const result = await generateObjectCompat({
    system:
      "你是 Git 提交信息助手。根据变更内容生成 Conventional Commits 风格的提交信息:类型用 feat/fix/refactor/docs/test/chore,标题英文、祈使语气、不超过 72 字符,概括最核心的变更;正文用简体中文说明修改内容。只输出符合 JSON Schema 的内容。",
    prompt: `请为以下未提交的变更生成提交信息。\n${taskPart}\n## 变更文件\n${statLines}\n\n## 关键 diff 片段\n${patchExcerpt}`,
    schema: commitMessageSchema,
    schemaName: "CommitMessage",
    maxOutputTokens: 4_000,
    signal: AbortSignal.timeout(180_000),
  });
  return { message: result.message.trim(), body: result.body.trim() };
}

/** 由历史提交推测消息(兜底用,不做 AI 调用)。 */
export function fallbackCommitMessage(taskTitle: string): string {
  const slug = taskTitle
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .slice(0, 40);
  return `feat: ${slug || "agent-task"}`;
}
