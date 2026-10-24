import { AiNotConfiguredError } from "@/server/ai/provider";
import { generateObjectCompat } from "@/server/ai/compat";
import {
  topicProposalOutputSchema,
  requirementOutputSchema,
  moduleFeaturesOutputSchema,
  type TopicProposalOutput,
  type RequirementOutput,
  type ModuleFeaturesOutput,
} from "./schemas";
import { topicProposalPrompt, requirementPrompt, moduleRegeneratePrompt } from "./prompts";

/** AI 生成调用统一走这里:超时保护 + 未配置错误的友好转译。 */

const GENERATE_TIMEOUT_MS = 480_000;
// 推理型模型(如 DeepSeek Flash)的思考过程也计入输出预算,需预留足够 token
// deepseek-flash 开启 thinking 时推理也消耗同一份额度；12k 会被推理吃光导致正文为空
// （finishReason=length、收到 0 个文本字符）。结构化产物（架构/需求）需要更大预算。
const MAX_OUTPUT_TOKENS = 32_000;

export class AiGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiGenerationError";
  }
}

function mapAiError(error: unknown): never {
  if (error instanceof AiNotConfiguredError) throw error;
  if (error instanceof Error && error.name === "TimeoutError") {
    throw new AiGenerationError("AI 生成超时,请稍后重试");
  }
  throw new AiGenerationError(`AI 生成失败:${error instanceof Error ? error.message : "未知错误"}`);
}

export function generateTopicProposal(input: {
  idea: string;
  type?: string;
  devLanguage?: string;
  database?: string;
  difficulty?: string;
  needsAi?: boolean;
}): Promise<TopicProposalOutput> {
  const { system, prompt } = topicProposalPrompt(input);
  return generateObjectCompat({
    system,
    prompt,
    schema: topicProposalOutputSchema,
    schemaName: "TopicProposal",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  }).catch(mapAiError);
}

export function generateRequirementDraft(project: {
  name: string;
  description: string | null;
  type: string;
  techStack: string[];
  difficulty: string | null;
  background?: string | null;
  goals?: string[];
}): Promise<RequirementOutput> {
  const { system, prompt } = requirementPrompt(project);
  return generateObjectCompat({
    system,
    prompt,
    schema: requirementOutputSchema,
    schemaName: "RequirementAnalysis",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  }).catch(mapAiError);
}

export function generateModuleFeatures(input: {
  project: { name: string; type: string; techStack: string[] };
  moduleName: string;
  moduleDescription: string;
  siblingModules: string[];
}): Promise<ModuleFeaturesOutput> {
  const { system, prompt } = moduleRegeneratePrompt(input);
  return generateObjectCompat({
    system,
    prompt,
    schema: moduleFeaturesOutputSchema,
    schemaName: "ModuleFeatures",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  }).catch(mapAiError);
}
