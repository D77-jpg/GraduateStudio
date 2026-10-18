import { describe, it, expect } from "vitest";
import { snapshot, stageWorkspace, workspaceDiff } from "@/server/agents/codex-workspace";
import fs from "node:fs/promises";
describe("isolated Codex changes", () => {
  it("audits creates modifies deletes and rejects out of scope changes", () => {
    const before = new Map([
      ["client/a.js", "a"],
      ["client/b.js", "b"],
    ]);
    const after = new Map([
      ["client/a.js", "updated"],
      ["client/c.js", "c"],
    ]);
    expect(workspaceDiff(before, after, true).map((c) => c.action)).toEqual([
      "modify",
      "delete",
      "create",
    ]);
    expect(() => workspaceDiff(before, new Map([...after, ["backend/a.js", "bad"]]), true)).toThrow(
      "越界",
    );
  });
  it("copies text into a separate workspace without exposing env files", async () => {
    const stage = await stageWorkspace(new Map([["client/a.js", "a"]]));
    try {
      await fs.writeFile(stage + "/.env", "secret");
      expect([...(await snapshot(stage))]).toEqual([["client/a.js", "a"]]);
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  });
});
