import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inventoryWorkspace, type WorkspaceInventory } from "./codex-assets";

/** Preserve generated environment files outside the model mount. Never publish or log contents. */
export async function quarantineGeneratedEnvironment(
  stage: string,
  baseline: WorkspaceInventory,
): Promise<string[]> {
  const inventory = await inventoryWorkspace(stage);
  const existing = new Set(baseline.excluded);
  // Content-validated .env.example files are inventoried as source, not exclusions.
  // Invalid examples remain excluded and are quarantined exactly like other env files.
  const files = inventory.excluded.filter(
    (file) => !existing.has(file) && /^\.env(?:\..*)?$/.test(path.posix.basename(file)),
  );
  if (!files.length) return [];
  const quarantine = path.join(path.dirname(stage), "quarantined-environment", randomUUID());
  for (const file of files) {
    if (file.split("/").some((part) => part === ".." || part === "."))
      throw new Error("Invalid quarantine path");
    const source = path.join(stage, file);
    if (!(await fs.lstat(source)).isFile())
      throw new Error(`环境路径不是普通文件，拒绝继续：${file}`);
    const target = path.join(quarantine, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Same-filesystem rename preserves bytes and avoids reading secrets into logs.
    await fs.rename(source, target);
  }
  return files;
}
