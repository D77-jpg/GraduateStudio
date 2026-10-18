import { describe, expect, it } from "vitest";
import {
  changedPathsFromProposal,
  parseCodexImplementationResult,
} from "@/server/agents/adapters/codex-result";

describe("Codex result contract", () => {
  it("accepts only complete-file implementation JSON", () => {
    const value = parseCodexImplementationResult({
      runId: "r",
      engine: "codex",
      exitCode: 0,
      threadId: "t",
      changedPaths: [],
      violations: [],
      lastMessage: JSON.stringify({
        notes: "ok",
        changes: [{ action: "modify", path: "client/src/App.vue", content: "<template/>" }],
      }),
    });
    expect(changedPathsFromProposal(value)).toEqual(["client/src/App.vue"]);
  });
  it("rejects nonzero, malformed, and incomplete results", () => {
    expect(() =>
      parseCodexImplementationResult({
        runId: "r",
        engine: "codex",
        exitCode: 1,
        threadId: null,
        changedPaths: [],
        violations: [],
        lastMessage: "",
      }),
    ).toThrow("Codex 执行失败");
    expect(() =>
      parseCodexImplementationResult({
        runId: "r",
        engine: "codex",
        exitCode: 0,
        threadId: null,
        changedPaths: [],
        violations: [],
        lastMessage: "not json",
      }),
    ).toThrow("合法的实现 JSON");
    expect(() =>
      parseCodexImplementationResult({
        runId: "r",
        engine: "codex",
        exitCode: 0,
        threadId: null,
        changedPaths: [],
        violations: [],
        lastMessage: JSON.stringify({ notes: "missing changes" }),
      }),
    ).toThrow("完整文件契约");
  });
});
