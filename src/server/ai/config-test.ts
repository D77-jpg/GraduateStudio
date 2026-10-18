import { generateText } from "ai";
import type { AiEnv } from "./env";
import { getChatModel } from "./provider";

/** Explicit-only probe; no persistence and no upstream text, URL or exception is returned. */
export async function testAiConnection(env: AiEnv) {
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, 15_000);
    });
    await Promise.race([
      generateText({
        model: getChatModel(env),
        prompt: "Reply with OK.",
        maxOutputTokens: 20,
        maxRetries: 0,
        abortSignal: controller.signal,
      }),
      timeout,
    ]);
    return { ok: true as const, tested: true as const, durationMs: Date.now() - started };
  } catch {
    return {
      ok: false as const,
      code: controller.signal.aborted ? "connection_timeout" : "connection_failed",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
