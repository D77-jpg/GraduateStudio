import { describe, it, expect } from "vitest";
import { getAiRequestTimeoutMs, getAiGenerationTimeoutMs } from "@/server/ai/request-limits";

describe("caller-controlled generation lifetime", () => {
  it("has no platform request or generation deadline", () => {
    expect(getAiRequestTimeoutMs({})).toBeUndefined();
    expect(getAiGenerationTimeoutMs()).toBeUndefined();
  });
  it("does not restore a deadline through legacy environment settings", () => {
    for (const value of ["0", "2", "30", "NaN", "999", "Infinity"])
      expect(getAiRequestTimeoutMs({ AI_REQUEST_TIMEOUT_MINUTES: value })).toBeUndefined();
  });
});
