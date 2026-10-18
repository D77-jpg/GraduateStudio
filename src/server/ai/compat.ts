import { streamText } from "ai";
import { z } from "zod";
import {
  getChatModel,
  resolveProviderSelection,
  resolveProviderBaseURL,
} from "@/server/ai/provider";
import { DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS, isOfficialDeepSeekFlash } from "./request-policy";
import { getAiEnv, type AiProviderId } from "@/server/ai/env";
import { summarizeAiNetworkError } from "./network-diagnostics";
import { AiOutputFormatError, extractOutputJson } from "./output-json";
export { AiOutputFormatError, CompatGenerateError } from "./output-json";

/**
 * generateObject 兼容层:面向不支持 json_schema 结构化输出的网关
 * (DeepSeek / Grok / 部分聚合网关)。
 * 降级策略:把 JSON Schema 注入提示词,用普通文本生成 + 提取 JSON + Zod 校验,
 * 仅在尚无文本/推理输出时对瞬时上游故障最多请求三次,不设置平台时限;仅官方 DeepSeek Flash 使用已验证的
 * 模型输出额度和 JSON wire 策略,其他服务不新增默认额度;取消由调用方控制。
 */

export class AiRequestError extends Error {
  constructor(diagnostic = "") {
    super(`AI 请求失败,请检查服务连接后重试${diagnostic ? `（${diagnostic}）` : ""}`);
    this.name = "AiRequestError";
  }
}

export class AiRequestTimeoutError extends Error {
  constructor() {
    super("AI 服务或上游网关报告请求超时；平台未设置固定生成时限，请检查服务响应后决定是否重试。");
    this.name = "AiRequestTimeoutError";
  }
}

/** Allowlisted diagnostics only: never include prompts, credentials or upstream errors/bodies. */
export type AiRequestEvent = {
  type: "started" | "progress" | "completed" | "failed";
  firstResponseMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  provider: AiProviderId;
  model: string;
  requestedBudget?: number;
  attempt: number;
  durationMs: number;
  finishReason?: string;
  textChars: number;
  reasoningChars: number;
  errorKind?: "timeout" | "cancelled" | "network" | "invalid-json";
};

export type AiRequestEventCallback = (event: AiRequestEvent) => void | Promise<void>;

/** Race even non-cooperative transports/callbacks; always detach the abort listener. */
function withinSignal<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Classify only bounded metadata; never log or serialize upstream errors. */
function isTransientFailure(error: unknown): boolean {
  const visited = new Set<object>();
  let transport = false;
  let status: number | undefined;
  let current = error;
  const read = (value: object, key: string): unknown => {
    try {
      return (value as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  };
  for (let depth = 0; depth <= 5; depth++) {
    if (!current || typeof current !== "object" || visited.has(current)) break;
    visited.add(current);
    const name = read(current, "name");
    const code = read(current, "code");
    // Explicit cancellation and transport deadlines retain their existing terminal behavior.
    if (
      name === "AbortError" ||
      name === "TimeoutError" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT"
    )
      return false;
    for (const key of ["statusCode", "status"]) {
      const value = read(current, key);
      if (
        status === undefined &&
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 100 &&
        value <= 599
      )
        status = value;
    }
    if (
      typeof code === "string" &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "EPIPE",
        "ENOTFOUND",
        "EAI_AGAIN",
        "ETIMEDOUT",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT_TIMEOUT",
      ].includes(code)
    )
      transport = true;
    if (
      name === "TypeError" &&
      [
        "fetch failed",
        "Failed to fetch",
        "NetworkError when attempting to fetch resource.",
      ].includes(read(current, "message") as string)
    )
      transport = true;
    current = read(current, "cause");
  }
  // An explicit HTTP status wins over transport metadata (e.g. a wrapped HTTP 401).
  return status === undefined ? transport : [429, 502, 503, 504].includes(status);
}

/** Abort clears the timer too, so cancellation never starts another attempt. */
function retryBackoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export async function generateObjectCompat<T>(options: {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens?: number;
  signal: AbortSignal;
  onRequestEvent?: AiRequestEventCallback;
}): Promise<T> {
  const jsonSchema = z.toJSONSchema(options.schema, { io: "output" });
  const schemaInstruction = [
    "你必须只输出一个合法的 JSON 对象(不要输出任何其他文本、Markdown 或代码围栏),",
    `且必须符合以下 JSON Schema(schemaName: ${options.schemaName}):`,
    JSON.stringify(jsonSchema),
  ].join("\n");

  options.signal.throwIfAborted();
  const env = getAiEnv();
  const selection = resolveProviderSelection(env);
  const official = isOfficialDeepSeekFlash(
    selection,
    resolveProviderBaseURL(env, selection.provider),
  );
  const model = getChatModel(env, { structuredGeneration: true });
  // Only official Flash has a verified model-specific default; explicit caller budgets win.
  const budget = Number.isFinite(options.maxOutputTokens)
    ? options.maxOutputTokens
    : official
      ? DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS
      : undefined;
  options.signal.throwIfAborted();
  const signal = options.signal;
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    const started = Date.now();
    const base = {
      ...selection,
      ...(budget === undefined ? {} : { requestedBudget: budget }),
      attempt,
    };
    let textChars = 0;
    let reasoningChars = 0;
    let finishReason: string | undefined;
    let firstResponseMs: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let reasoningTokens: number | undefined;
    let lastProgress = started;
    let text = "";
    const metrics = () => ({ firstResponseMs, inputTokens, outputTokens, reasoningTokens });
    const safeTokens = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    const emit = async (type: AiRequestEvent["type"], errorKind?: AiRequestEvent["errorKind"]) => {
      if (!options.onRequestEvent) return;
      try {
        await withinSignal(
          Promise.resolve(
            options.onRequestEvent({
              ...base,
              ...metrics(),
              type,
              durationMs: Date.now() - started,
              textChars,
              reasoningChars,
              finishReason,
              errorKind,
            }),
          ),
          signal,
        );
      } catch {
        if (options.signal.aborted) throw options.signal.reason;
        throw new AiRequestError();
      }
    };
    try {
      await emit("started");
      signal.throwIfAborted();
      const result = streamText({
        model,
        system: `${options.system}\n\n${schemaInstruction}`,
        prompt: options.prompt,
        ...(budget === undefined ? {} : { maxOutputTokens: budget }),
        ...(official ? { providerOptions: { openai: { reasoningEffort: "high" } } } : {}),
        maxRetries: 0,
        abortSignal: signal,
        // Errors are handled below, not logged with upstream bodies by the SDK default handler.
        onError: () => {},
      });
      const iterator = result.fullStream[Symbol.asyncIterator]();
      let sawFinish = false;
      while (true) {
        const next = await withinSignal(iterator.next(), signal);
        signal.throwIfAborted();
        if (next.done) break;
        const part = next.value;
        if (part.type === "error") throw part.error;
        if (part.type === "abort") {
          signal.throwIfAborted();
          throw new AiRequestError();
        }
        if (part.type === "finish") sawFinish = true;
        if (part.type === "text-delta" || part.type === "reasoning-delta") {
          const firstResponse = firstResponseMs === undefined && part.text.length > 0;
          if (firstResponse) firstResponseMs = Date.now() - started;
          if (part.type === "text-delta") {
            text += part.text;
            textChars += part.text.length;
          } else {
            // Never retain or persist reasoning text.
            reasoningChars += part.text.length;
          }
          if (firstResponse || Date.now() - lastProgress >= 1_000) {
            lastProgress = Date.now();
            await emit("progress");
          }
        }
      }
      if (!sawFinish) throw new AiRequestError();
      const [sdkFinishReason, usage] = await withinSignal(
        Promise.all([result.finishReason, result.usage]),
        signal,
      );
      signal.throwIfAborted();
      inputTokens = safeTokens(usage.inputTokens);
      outputTokens = safeTokens(usage.outputTokens);
      reasoningTokens = safeTokens(usage.outputTokenDetails?.reasoningTokens);
      // SDK finish reasons are an enum; do not forward arbitrary upstream strings.
      finishReason = [
        "stop",
        "length",
        "content-filter",
        "tool-calls",
        "error",
        "other",
        "unknown",
      ].includes(sdkFinishReason)
        ? sdkFinishReason
        : "unknown";
      if (finishReason === "error") throw new AiRequestError();
    } catch (error) {
      const errorKind = options.signal.aborted
        ? options.signal.reason?.name === "TimeoutError"
          ? "timeout"
          : "cancelled"
        : error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "network";
      // Preserve failure diagnostics without replacing the original error; cancellation remains caller-owned.
      if (options.onRequestEvent) {
        const event: AiRequestEvent = {
          ...base,
          ...metrics(),
          type: "failed",
          durationMs: Date.now() - started,
          textChars,
          reasoningChars,
          finishReason,
          errorKind,
        };
        try {
          await withinSignal(Promise.resolve(options.onRequestEvent(event)), options.signal);
        } catch {
          /* Diagnostics cannot replace the original failure. */
        }
      }
      if (options.signal.aborted) throw options.signal.reason;
      if (attempt < 3 && textChars === 0 && reasoningChars === 0 && isTransientFailure(error)) {
        await retryBackoff(attempt === 1 ? 1_000 : 3_000, signal);
        continue;
      }
      if (errorKind === "timeout") throw new AiRequestTimeoutError();
      throw new AiRequestError(summarizeAiNetworkError(error));
    }

    if (finishReason === "length") {
      await emit("failed", "invalid-json");
      throw new AiOutputFormatError(
        "length",
        `模型或上游服务报告长度截断（finishReason=length，收到 ${textChars} 个文本字符、${reasoningChars} 个推理字符${budget === undefined ? "，平台未设置输出额度" : `，调用方额度 ${budget} tokens`}）；未收到完整输出，未自动重试。`,
      );
    }
    let parsed: T;
    try {
      parsed = extractOutputJson(text, options.schema);
    } catch (error) {
      await emit("failed", "invalid-json");
      if (error instanceof AiOutputFormatError) {
        throw new AiOutputFormatError(
          error.kind,
          `${error.message}（finishReason=${finishReason}）`,
        );
      }
      // Custom schema refinements may throw arbitrary errors: never forward their contents.
      throw new AiOutputFormatError(
        "schema",
        `AI 输出 JSON Schema 校验失败（finishReason=${finishReason}，收到 ${textChars} 个文本字符）；未自动重试。`,
      );
    }
    await emit("completed");
    signal.throwIfAborted();
    return parsed;
  }
  // Every attempt either returns, retries, or throws.
  throw new AiRequestError();
}
