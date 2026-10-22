import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isJavaBuildOutput, isPythonCache } from "./codex-assets";
import { readSafeEnvExample } from "./codex-env-example";

// .venv/venv：Python 虚拟环境（含符号链接，会让清单复制失败）。
const EXCLUDED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".venv",
  "venv",
]);
const LIMIT = 32 * 1024 * 1024;
export async function snapshot(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let bytes = 0;
  async function visit(directory: string, prefix = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const example =
        entry.name === ".env.example" && entry.isFile() ? await readSafeEnvExample(file) : null;
      if (
        EXCLUDED.has(entry.name) ||
        isPythonCache(entry.name) ||
        (entry.isDirectory() && (await isJavaBuildOutput(directory, entry.name))) ||
        (entry.name.toLowerCase().startsWith(".env") && !example) ||
        /^(?:auth\.json|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx|sqlite|sqlite3|db))$/i.test(
          entry.name,
        ) ||
        entry.isSymbolicLink()
      )
        continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(file, relative + "/");
      else if (entry.isFile()) {
        const stat = await fs.stat(file);
        if (stat.size > 2 * 1024 * 1024) throw new Error(`文件超过审计大小限制: ${relative}`);
        bytes += stat.size;
        if (bytes > LIMIT) throw new Error("工作区超过 32MB 审计限制");
        const data = example ?? (await fs.readFile(file));
        if (data.includes(0)) continue;
        const text = data.toString("utf8");
        if (!Buffer.from(text).equals(data)) continue;
        result.set(relative, text);
      }
    }
  }
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("不允许符号链接工作区");
  await visit(root);
  return result;
}
export async function stageWorkspace(before: Map<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "graduatestudio-codex-"));
  for (const [relative, content] of before) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return root;
}
export function workspaceDiff(
  before: Map<string, string>,
  after: Map<string, string>,
  uiOnly: boolean,
) {
  const changes: Array<{ path: string; action: "create" | "modify" | "delete"; content: string }> =
    [];
  for (const relative of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(relative) === after.get(relative)) continue;
    if (uiOnly && !relative.startsWith("client/"))
      throw new Error(`Codex UI任务越界，未应用任何提议: ${relative}`);
    changes.push({
      path: relative,
      action: !after.has(relative) ? "delete" : before.has(relative) ? "modify" : "create",
      content: after.get(relative) ?? "",
    });
  }
  return changes;
}
