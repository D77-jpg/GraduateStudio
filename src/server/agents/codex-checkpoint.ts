import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getWorkspaceRoot, PROJECT_ID_PATTERN } from "@/server/workspace/paths";

const id = z.string().regex(PROJECT_ID_PATTERN);
export const codexCheckpointSchema = z
  .object({
    version: z.literal(1),
    engine: z.literal("codex"),
    taskId: id,
    projectId: id,
    mode: z.enum(["local", "full"]),
    message: z.string(),
    phase: z.enum([
      "running",
      "paused",
      "interrupted",
      "awaiting_acceptance",
      "applied_unverified",
      "completed",
      "cancelled",
      "failed",
    ]),
    attempt: z.number().int().nonnegative(),
    nextStepIndex: z.number().int().nonnegative(),
    stage: z.string().min(1),
    baseline: z.record(z.string(), z.string()),
    requirementHash: z.string().nullable(),
    pendingChangeSetId: id.nullable(),
    error: z.string().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CodexCheckpoint = z.infer<typeof codexCheckpointSchema>;

function locations(projectId: string, taskId: string) {
  id.parse(projectId);
  id.parse(taskId);
  const root = path.resolve(
    process.env.GRADUATESTUDIO_STATE_ROOT || path.join(process.cwd(), ".agent-state"),
  );
  const workspace = getWorkspaceRoot();
  if (root === workspace || root.startsWith(workspace + path.sep))
    throw new Error("Checkpoint state must be outside the model workspace");
  const directory = path.join(root, projectId, "codex-tasks", taskId);
  return {
    directory,
    file: path.join(directory, "checkpoint.json"),
    stage: path.join(directory, "stage"),
  };
}

/** Reject symlinks at every existing component, not only at the leaf. */
async function assertNoSymlinks(target: string) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error("Checkpoint paths cannot contain symlinks");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
function validate(value: unknown, projectId: string, taskId: string) {
  const cp = codexCheckpointSchema.parse(value);
  if (
    cp.projectId !== projectId ||
    cp.taskId !== taskId ||
    cp.stage !== locations(projectId, taskId).stage
  )
    throw new Error("Checkpoint identity or stage mismatch");
  return cp;
}
const writes = new Map<string, Promise<void>>();
export async function loadCodexCheckpoint(
  projectId: string,
  taskId: string,
): Promise<CodexCheckpoint | null> {
  const loc = locations(projectId, taskId);
  await writes.get(loc.file);
  await assertNoSymlinks(loc.file);
  await assertNoSymlinks(loc.stage);
  try {
    return validate(JSON.parse(await fs.readFile(loc.file, "utf8")), projectId, taskId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function saveCodexCheckpoint(checkpoint: CodexCheckpoint): Promise<void> {
  const cp = validate(checkpoint, checkpoint.projectId, checkpoint.taskId);
  const loc = locations(cp.projectId, cp.taskId);
  const payload = JSON.stringify({ ...cp, updatedAt: new Date().toISOString() });
  const previous = writes.get(loc.file) ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(async () => {
      await assertNoSymlinks(loc.file);
      await assertNoSymlinks(loc.stage);
      await fs.mkdir(loc.directory, { recursive: true });
      await assertNoSymlinks(loc.file);
      const temp = path.join(loc.directory, `.checkpoint-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await fs.rename(temp, loc.file);
      } finally {
        await fs.rm(temp, { force: true });
      }
    });
  writes.set(loc.file, write);
  try {
    await write;
  } finally {
    if (writes.get(loc.file) === write) writes.delete(loc.file);
  }
}
export async function createCodexCheckpoint(input: {
  taskId: string;
  projectId: string;
  mode: "local" | "full";
  message: string;
  baseline: Record<string, string>;
  requirementHash?: string | null;
}): Promise<CodexCheckpoint> {
  const loc = locations(input.projectId, input.taskId);
  await assertNoSymlinks(loc.stage);
  await fs.mkdir(loc.stage, { recursive: true });
  const cp: CodexCheckpoint = {
    ...input,
    version: 1,
    engine: "codex",
    phase: "running",
    attempt: 0,
    nextStepIndex: 0,
    stage: loc.stage,
    requirementHash: input.requirementHash ?? null,
    pendingChangeSetId: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };
  await saveCodexCheckpoint(cp);
  return cp;
}

/** Explicit public projection: never expose stage, baseline, message, or model state. */
export function codexExecutionMetadata(cp: CodexCheckpoint) {
  return {
    engine: cp.engine,
    mode: cp.mode,
    phase: cp.phase,
    attempt: cp.attempt,
    resumable:
      !cp.pendingChangeSetId && ["paused", "interrupted", "failed", "running"].includes(cp.phase),
    pendingChangeSetId: cp.pendingChangeSetId,
  };
}
