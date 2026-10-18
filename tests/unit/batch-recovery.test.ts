import { describe, it, expect } from "vitest";
import {
  splitTimedOutGenerationBatch,
  isGenerationTimeout,
  generationOutputFailureKind,
  isRecoverableGenerationFailure,
} from "@/lib/batch-recovery";

function state() {
  return {
    currentPlan: {
      steps: Array.from({ length: 7 }, (_, i) => ({
        path: `src/${i}.ts`,
        action: "create" as const,
      })),
    },
    batchCursor: 1,
    pendingChangeSetId: null as string | null,
    generationBatches: undefined as number[][] | undefined,
    generationBatchKeys: undefined as string[] | undefined,
    batchRecovery: undefined as { moduleId: string; attempts: string[] } | undefined,
  };
}
describe("safe timeout batch transition", () => {
  it.each(["json", "schema", "length"] as const)(
    "recognizes typed %s only, including preserved wrapper causes",
    (kind) => {
      const typed = Object.assign(new Error("output rejected"), {
        name: "AiOutputFormatError",
        kind,
      });
      expect(generationOutputFailureKind(typed)).toBe(kind);
      expect(
        generationOutputFailureKind(
          Object.assign(new Error("wrapped", { cause: typed }), { name: "CodingAgentError" }),
        ),
      ).toBe(kind);
      expect(isRecoverableGenerationFailure(typed)).toBe(true);
      expect(generationOutputFailureKind({ name: "AiOutputFormatError", kind })).toBeNull();
    },
  );
  it("allowlists historical JSON/schema/length errors but never runtime messages or network failures", () => {
    for (const prefix of ["", "AI 调用失败:"]) {
      expect(
        generationOutputFailureKind(
          `${prefix}AI 输出包含多个符合 JSON Schema 的完整根对象，存在歧义`,
        ),
      ).toBe("json");
      expect(
        generationOutputFailureKind(`${prefix}AI 输出还包含未闭合的 JSON 根块，不能安全忽略`),
      ).toBe("json");
      expect(
        generationOutputFailureKind(
          `${prefix}AI 输出未找到可解析的完整 JSON 对象（finishReason=stop）`,
        ),
      ).toBe("json");
      expect(generationOutputFailureKind(`${prefix}AI 输出JSON Schema 校验失败（2 项问题）`)).toBe(
        "schema",
      );
      expect(generationOutputFailureKind(`${prefix}AI 输出 JSON Schema 校验失败（2 项问题）`)).toBe(
        "schema",
      );
      expect(
        generationOutputFailureKind(`${prefix}模型或上游服务报告长度截断（finishReason=length）`),
      ).toBe("length");
    }
    for (const error of [
      new Error("AI 输出未找到可解析的完整 JSON 对象"),
      "AI 调用失败:network error: AI 输出JSON Schema 校验失败",
      "AI 调用失败:upstream length error",
      "AI 调用失败:JSON Schema 校验失败",
      Object.assign(new Error("invalid"), { name: "AiOutputFormatError", kind: "network" }),
    ])
      expect(isRecoverableGenerationFailure(error)).toBe(false);
  });
  it("converts legacy boundaries without shifting completed files and avoids suffix title collisions", () => {
    const cp = state();
    expect(splitTimedOutGenerationBatch(cp, "activity6")).toBe(true);
    expect(cp.generationBatches).toEqual([[0, 1], [2], [3], [4, 5], [6]]);
    expect(cp.generationBatchKeys).toEqual(["0", "files-2", "files-3", "files-4-5", "files-6"]);
    expect(cp.batchCursor).toBe(1);
  });
  it("splits progressively down to individual files after JSON resume", () => {
    const cp = state();
    cp.generationBatches = [[0], [1, 2, 3, 4], [5, 6]];
    expect(splitTimedOutGenerationBatch(cp, "module")).toBe(true);
    const restored = JSON.parse(JSON.stringify(cp));
    expect(splitTimedOutGenerationBatch(restored, "module")).toBe(true);
    expect(splitTimedOutGenerationBatch(restored, "module")).toBe(false);
    restored.batchCursor = 3;
    expect(splitTimedOutGenerationBatch(restored, "module")).toBe(true);
  });
  it("never splits pending or single-file batches", () => {
    const cp = state();
    cp.pendingChangeSetId = "pending";
    expect(splitTimedOutGenerationBatch(cp, "module")).toBe(false);
    cp.pendingChangeSetId = null;
    cp.batchCursor = 3;
    expect(splitTimedOutGenerationBatch(cp, "module")).toBe(false);
  });
  it("requires typed timeout or explicit historical normalized timeout, not generic faults", () => {
    expect(
      isGenerationTimeout(Object.assign(new Error("timed out"), { name: "AiRequestTimeoutError" })),
    ).toBe(true);
    expect(isGenerationTimeout("AI 生成超时,请稍后重试")).toBe(true);
    for (const error of [
      new Error("network timeout"),
      "AI 调用失败:timeout",
      "完整生成已达到本次时间预算",
      "abort",
    ]) {
      expect(isGenerationTimeout(error)).toBe(false);
    }
  });
});
