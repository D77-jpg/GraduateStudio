import { generateText } from "ai";
import { z } from "zod";
import { getChatModel } from "@/server/ai/provider";

/**
 * generateObject 兼容层:面向不支持 json_schema 结构化输出的网关
 * (DeepSeek / Grok / 部分聚合网关)。
 * 降级策略:把 JSON Schema 注入提示词,用普通文本生成 + 提取 JSON + Zod 校验,
 * 失败带错误重试(最多 2 次);推理模型输出超预算截断时自动翻倍输出预算。
 */

export class CompatGenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompatGenerateError";
  }
}

const MAX_RETRIES = 2;
const MIN_BUDGET = 32768;
const MAX_BUDGET = 65536;

/** 字符串感知的大括号平衡提取:跳过字符串字面量内部的引号与大括号。 */
function extractBalancedObject(source: string): string | null {
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // 快速路径:整段就是 JSON(推理模型最常见的形态)
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      const balanced = extractBalancedObject(trimmed);
      if (balanced) {
        try {
          return JSON.parse(balanced);
        } catch {
          /* 落到后续策略 */
        }
      }
    }
  }

  // 代码围栏:文件内容里可能本身包含 ```,逐个候选尝试而不是取第一个匹配
  const fenced = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)].map((m) => m[1].trim());
  for (const candidate of fenced) {
    if (!candidate.startsWith("{")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* 尝试下一个候选 */
    }
  }

  // 兜底:从首个 { 起做括号平衡提取
  const balanced = extractBalancedObject(text);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch {
      /* 继续抛出 */
    }
  }

  const head = trimmed.slice(0, 80);
  throw new Error(
    `响应中未找到完整 JSON 对象(长度 ${trimmed.length},开头 ${JSON.stringify(head)})`,
  );
}

export async function generateObjectCompat<T>(options: {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}): Promise<T> {
  const jsonSchema = z.toJSONSchema(options.schema, { io: "output" });
  const schemaInstruction = [
    "你必须只输出一个合法的 JSON 对象(不要输出任何其他文本、Markdown 或代码围栏),",
    `且必须符合以下 JSON Schema(schemaName: ${options.schemaName}):`,
    JSON.stringify(jsonSchema),
  ].join("\n");

  let lastError = "";
  let budget = Math.max(options.maxOutputTokens, MIN_BUDGET);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (options.signal.aborted) throw new Error("请求已取消");
    const retryNote =
      attempt > 0
        ? `\n\n上一次输出未通过 JSON 校验,请修正。校验错误:${lastError.slice(0, 800)}`
        : "";

    const result = await generateText({
      model: getChatModel(),
      system: `${options.system}\n\n${schemaInstruction}${retryNote}`,
      prompt: options.prompt,
      // 推理模型(DeepSeek Flash 等)的思考过程计入输出预算,给足空间
      maxOutputTokens: budget,
      abortSignal: options.signal,
    });

    if (!result.text || result.text.trim().length === 0) {
      const reasoningLen = (result.reasoning ?? [])
        .filter((part) => part.type === "reasoning")
        .reduce((sum, part) => sum + part.text.length, 0);
      lastError = `模型未输出任何内容(思考过程消耗 ${reasoningLen} 字符,输出可能被推理占满)`;
      if (attempt === MAX_RETRIES) break;
      continue;
    }

    // 输出被 maxOutputTokens 截断:直接翻倍预算重试,不当作内容错误提示模型
    if (result.finishReason === "length" && attempt < MAX_RETRIES) {
      budget = Math.min(budget * 2, MAX_BUDGET);
      lastError = `输出被截断(finish_reason=length),已将输出预算提高到 ${budget}`;
      continue;
    }

    try {
      const parsed = options.schema.parse(extractJson(result.text));
      return parsed;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === MAX_RETRIES) break;
    }
  }

  throw new CompatGenerateError(
    `AI 输出连续 ${MAX_RETRIES + 1} 次未通过 JSON 校验:${lastError.slice(0, 400)}`,
  );
}
