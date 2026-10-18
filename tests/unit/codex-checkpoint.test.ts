import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexCheckpoint, loadCodexCheckpoint, saveCodexCheckpoint, codexExecutionMetadata } from "@/server/agents/codex-checkpoint";
import { agentExecutionDtoSchema } from "@/lib/agent";
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-checkpoint-"));
  vi.stubEnv("GRADUATESTUDIO_STATE_ROOT", root);
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
const create = () => createCodexCheckpoint({ taskId: "task", projectId: "project", mode: "local", message: "test", baseline: { "a.ts": "hash" } });
describe("app-owned Codex checkpoints", () => {
  it("round trips outside stage and serializes atomic writes", async () => {
    const cp = await create();
    expect(await fs.stat(cp.stage)).toBeTruthy();
    await Promise.all([saveCodexCheckpoint({ ...cp, attempt: 1 }), saveCodexCheckpoint({ ...cp, attempt: 2 })]);
    expect((await loadCodexCheckpoint("project", "task"))?.attempt).toBe(2);
    expect(await fs.readdir(cp.stage)).toEqual([]);
    expect((await fs.readdir(path.dirname(cp.stage))).sort()).toEqual(["checkpoint.json", "stage"]);
  });
  it("rejects tampered identity, stage, and malformed JSON instead of legacy fallback", async () => {
    const cp = await create();
    await expect(saveCodexCheckpoint({ ...cp, stage: path.join(root, "elsewhere") })).rejects.toThrow();
    const file = path.join(path.dirname(cp.stage), "checkpoint.json");
    await fs.writeFile(file, JSON.stringify({ ...cp, taskId: "other" }));
    await expect(loadCodexCheckpoint("project", "task")).rejects.toThrow();
    await fs.writeFile(file, "{");
    await expect(loadCodexCheckpoint("project", "task")).rejects.toThrow();
    await expect(loadCodexCheckpoint("../escape", "task")).rejects.toThrow();
  });
  it("rejects symlinked state (where platform supports creating links)", async () => {
    const destination = path.join(root, "real"); await fs.mkdir(destination);
    try { await fs.symlink(destination, path.join(root, "project"), "junction"); }
    catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return; throw error; }
    await expect(create()).rejects.toThrow(/symlink/);
  });
  it("projects only safe execution capabilities, review can never rerun", async () => {
    const cp = await create();
    const dto = codexExecutionMetadata({ ...cp, phase: "awaiting_acceptance", pendingChangeSetId: "review" });
    expect(dto.resumable).toBe(false);
    expect(dto).not.toHaveProperty("stage"); expect(dto).not.toHaveProperty("baseline");
    expect(agentExecutionDtoSchema.parse({ ...dto, stage: cp.stage })).not.toHaveProperty("stage");
    expect(codexExecutionMetadata({ ...cp, phase: "applied_unverified" }).resumable).toBe(false);
  });
});
