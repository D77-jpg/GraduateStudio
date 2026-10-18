import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readSafeEnvExample } from "./codex-env-example";

export function isPythonCache(name: string): boolean {
  return (
    ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"].includes(name) ||
    /\.py[co]$/i.test(name)
  );
}

const EXCLUDED = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const PRIVATE =
  /^(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx|sqlite|sqlite3|db))$/i;
export interface WorkspaceInventory {
  hashes: Record<string, string>;
  excluded: string[];
  binary: string[];
}
/** Bounded inventory; never follows links. Secrets/data and generated dependencies are explicit omissions. */
export async function inventoryWorkspace(
  root: string,
  destination?: string,
): Promise<WorkspaceInventory> {
  const result: WorkspaceInventory = {
    hashes: Object.create(null) as Record<string, string>,
    excluded: [],
    binary: [],
  };
  let bytes = 0;
  let count = 0;
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("工作区根目录不能是符号链接");
  async function visit(directory: string, prefix = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`工作区含符号链接，拒绝未审计复制：${rel}`);
      // Disposable interpreter/test caches are neither source nor security exclusions.
      if (isPythonCache(entry.name)) continue;
      const file = path.join(directory, entry.name);
      const example =
        entry.name === ".env.example" && entry.isFile() ? await readSafeEnvExample(file) : null;
      if (
        !example &&
        (EXCLUDED.has(entry.name) || PRIVATE.test(entry.name) || entry.name.startsWith(".env"))
      ) {
        result.excluded.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(file, rel + "/");
        continue;
      }
      if (!entry.isFile()) throw new Error(`不支持的文件类型：${rel}`);
      const stat = await fs.lstat(file);
      if (stat.nlink !== 1) throw new Error(`工作区含硬链接，拒绝未审计复制：${rel}`);
      if (stat.size > 8 * 1024 * 1024 || (bytes += stat.size) > 64 * 1024 * 1024 || ++count > 10000)
        throw new Error("项目超过受控副本限制（8MB/文件、64MB总计、10000文件）");
      const data = example ?? (await fs.readFile(file));
      result.hashes[rel] = createHash("sha256").update(data).digest("hex");
      if (data.includes(0) || !Buffer.from(data.toString("utf8")).equals(data))
        result.binary.push(rel);
      if (destination) {
        const target = path.join(destination, rel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, data);
      }
    }
  }
  await visit(root);
  return result;
}
export function assertInventoryUnchanged(
  before: WorkspaceInventory,
  after: WorkspaceInventory,
  label: string,
) {
  const paths = new Set([...Object.keys(before.hashes), ...Object.keys(after.hashes)]);
  for (const file of paths)
    if (before.hashes[file] !== after.hashes[file]) throw new Error(`${label}：${file}`);
}
export function assertBinaryUnchanged(before: WorkspaceInventory, after: WorkspaceInventory) {
  for (const file of new Set([...before.binary, ...after.binary])) {
    if (before.hashes[file] !== after.hashes[file])
      throw new Error(`二进制文件变更暂不支持文本变更集，请单独审计：${file}`);
  }
}
