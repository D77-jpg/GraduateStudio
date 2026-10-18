import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireCodexProjectLease } from "@/server/agents/codex-lease";
describe("local Codex project lease", () => {
  it("refuses concurrent live owner and releases its own token", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-lease-"));
    const stage = path.join(root, "project", "codex-tasks", "task", "stage");
    await fs.mkdir(stage, { recursive: true });
    try {
      const release = await acquireCodexProjectLease(stage);
      await expect(acquireCodexProjectLease(stage)).rejects.toThrow("活动");
      await release();
      const again = await acquireCodexProjectLease(stage);
      await again();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
