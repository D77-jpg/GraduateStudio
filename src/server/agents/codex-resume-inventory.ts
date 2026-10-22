import fs from "node:fs/promises";
import path from "node:path";
import { assertBinaryUnchanged, type WorkspaceInventory } from "./codex-assets";

// These exact directories are already omitted by both inventoryWorkspace and snapshot.
// Do not allow arbitrary suffixes (e.g. tmp/dist) or descendants. target/.gradle are now
// excluded by both scanners too (Java build output produced when the worker runs Maven).
const BUILD_DIRECTORIES = new Set(
  ["", "client/", "frontend/", "web/", "server/", "backend/", "api/"].flatMap((prefix) =>
    ["dist", "build", ".next", "coverage", "target", ".gradle"].map((name) => prefix + name),
  ),
);

async function assertGeneratedDirectory(stage: string, relative: string): Promise<void> {
  let directory = stage;
  for (const part of ["", ...relative.split("/")]) {
    directory = part ? path.join(directory, part) : directory;
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`构建排除项必须是无链接的真实目录：${relative}`);
  }
  // Excluded directories are normally opaque to inventoryWorkspace. Validate link
  // safety here without reading/copying their contents or adding them to outputs.
  let count = 0;
  async function visit(root: string): Promise<void> {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (++count > 10000) throw new Error(`构建目录超过恢复检查限制：${relative}`);
      const file = path.join(root, entry.name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
        throw new Error(`构建目录含符号链接或硬链接，拒绝继续：${relative}`);
      if (stat.isDirectory()) await visit(file);
      else if (!stat.isFile()) throw new Error(`构建目录含不支持的文件类型：${relative}`);
    }
  }
  await visit(directory);
}

/** Read-only resume validation. Build outputs remain excluded, never published. */
export async function assertResumeInventoryAllowed(
  stage: string,
  baseline: WorkspaceInventory,
  copied: WorkspaceInventory,
): Promise<void> {
  assertBinaryUnchanged(baseline, copied);
  const initialExcluded = new Set(baseline.excluded);
  for (const relative of copied.excluded) {
    if (initialExcluded.has(relative)) continue;
    // Preserve the existing dependency exception, not a broader name/path rule.
    if (/(^|\/)node_modules$/.test(relative)) continue;
    if (!BUILD_DIRECTORIES.has(relative))
      throw new Error(`副本出现未经允许的环境、数据或依赖文件，拒绝继续：${relative}`);
    await assertGeneratedDirectory(stage, relative);
  }
}
