import { describe, expect, it } from "vitest";
import { buildRuntimeFixMessage, FIX_MESSAGE_LIMIT } from "@/lib/runtime-fix";

describe("runtime repair message", () => {
  it("keeps the entire request within the task API limit", () => {
    const message = buildRuntimeFixMessage([
      { stream: "stderr", text: "error: " + "x".repeat(10000) },
    ]);
    expect(message.length).toBeLessThanOrEqual(FIX_MESSAGE_LIMIT);
    expect(message).toContain("日志过长");
  });
  it("prioritizes missing imports over a long stack trace", () => {
    const message = buildRuntimeFixMessage([
      { stream: "stderr", text: 'Failed to resolve import "./App.vue" from "src/main.js"' },
      ...Array.from({ length: 30 }, (_, i) => ({
        stream: "stderr",
        text: `at frame${i} ${"x".repeat(150)}`,
      })),
    ]);
    expect(message).toContain('Failed to resolve import "./App.vue"');
    expect(message.length).toBeLessThanOrEqual(2000);
  });
  it("handles empty logs and removes repeated errors", () => {
    expect(buildRuntimeFixMessage([])).toContain("无明确错误输出");
    const message = buildRuntimeFixMessage([
      { stream: "stderr", text: "SyntaxError: broken" },
      { stream: "stderr", text: "SyntaxError: broken" },
    ]);
    expect(message.match(/SyntaxError: broken/g)).toHaveLength(1);
  });
});
