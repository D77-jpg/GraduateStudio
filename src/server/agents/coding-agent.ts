import { streamText } from "ai";
import { generateObjectCompat } from "@/server/ai/compat";
import { getChatModel, AiNotConfiguredError } from "@/server/ai/provider";
import { planOutputSchema, implementOutputSchema } from "@/lib/develop";
import type { z } from "zod";
import { buildCodingContext, renderContextForPrompt } from "./context";

/**
 * Coding Agent:计划(Plan)→ 实现(Implement)→ 聊天(Chat)。
 * 只生成"待确认的变更集",绝不直接写盘;自动执行闭环属于 Phase 5 的 Agent 编排器。
 */

const GENERATE_TIMEOUT_MS = 480_000;
const MAX_OUTPUT_TOKENS = 12_000;

export class CodingAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodingAgentError";
  }
}

function mapError(error: unknown): never {
  if (error instanceof AiNotConfiguredError) throw error;
  if (error instanceof Error && error.name === "TimeoutError") {
    throw new CodingAgentError("AI 生成超时,请稍后重试");
  }
  throw new CodingAgentError(`AI 调用失败:${error instanceof Error ? error.message : "未知错误"}`);
}

const SYSTEM_BASE = `你是 GraduateStudio 的编码 Agent,在一个学生毕业设计项目的工作区里协助开发。
规则:
1. 所有路径都是项目内的相对路径(正斜杠),禁止出现 ..、绝对路径、node_modules、.git。
2. 输出严格遵循给定 JSON Schema,文本用简体中文,代码要完整可运行(不写占位注释代替实现)。
3. 修改文件时给出修改后的【完整】文件内容,不要输出 diff 片段或省略号。
4. 尊重现有技术栈与代码风格,不擅自引入与项目无关的重型依赖。`;

export async function generatePlan(input: {
  projectId: string;
  userId: string;
  message: string;
  selectedFilePaths?: string[];
}): Promise<z.infer<typeof planOutputSchema>> {
  const context = await buildCodingContext(input.projectId, input.userId, input.selectedFilePaths);

  try {
    const parsed = await generateObjectCompat({
      system: SYSTEM_BASE,
      prompt: `${renderContextForPrompt(context)}

## 用户任务
${input.message}

请基于项目现状制定一个清晰的修改计划:每一步对应一个要新建/修改/删除的文件,说明原因。
要求:步骤不超过 10 个;每个文件的职责单一;计划可执行、可验收。`,
      schema: planOutputSchema,
      schemaName: "CodingPlan",
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
    return parsed;
  } catch (error) {
    mapError(error);
  }
}

export async function generateImplementation(input: {
  projectId: string;
  userId: string;
  message: string;
  plan: z.infer<typeof planOutputSchema>;
  selectedFilePaths?: string[];
}): Promise<z.infer<typeof implementOutputSchema>> {
  const modifyPaths = input.plan.steps
    .filter((step) => step.action !== "delete")
    .map((step) => step.path);
  const context = await buildCodingContext(input.projectId, input.userId, [
    ...(input.selectedFilePaths ?? []),
    ...modifyPaths,
  ]);

  const planText = input.plan.steps
    .map(
      (step, index) =>
        `${index + 1}. [${step.action}] ${step.path}${step.reason ? ` — ${step.reason}` : ""}`,
    )
    .join("\n");

  try {
    const parsed = await generateObjectCompat({
      system: SYSTEM_BASE,
      prompt: `${renderContextForPrompt(context)}

## 用户任务
${input.message}

## 已确认的修改计划
${planText}

${input.plan.risks ? `## 计划风险提示\n${input.plan.risks}\n` : ""}
请严格按照计划执行,输出每个文件的完整内容:
- create:新文件的完整内容
- modify:「用户当前打开的文件」一节中已有这些文件的最新内容,基于它们修改后输出完整内容
- delete:content 传空字符串
注意:不要遗漏计划中的任何文件;不要添加计划之外的文件。`,
      schema: implementOutputSchema,
      schemaName: "CodeChanges",
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
    return parsed;
  } catch (error) {
    mapError(error);
  }
}

/** AI 聊天(流式):返回 streamText 结果,路由层遍历 fullStream 转 SSE(reasoning + 文本)。 */
export async function streamChat(input: {
  projectId: string;
  userId: string;
  message: string;
  selectedFilePaths?: string[];
}) {
  const context = await buildCodingContext(
    input.projectId,
    input.userId,
    input.selectedFilePaths ?? [],
  );

  return streamText({
    model: getChatModel(),
    system: SYSTEM_BASE,
    prompt: `${renderContextForPrompt(context)}

## 用户消息
${input.message}

请作为编码助手回答:可以讨论方案、解释代码、给建议;真正的代码修改请让用户走「生成修改计划」流程。回答使用简体中文,简洁专业。`,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
}

export { renderContextForPrompt };
