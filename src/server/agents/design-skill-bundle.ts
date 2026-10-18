import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
const manifestSchema = z
  .object({
    version: z.literal(1),
    skills: z
      .array(
        z
          .object({
            id: z.enum(["ui-ux-pro-max", "frontend-design"]),
            revision: z.string().regex(/^[a-f0-9]{40}$/),
            source: z.string().url(),
            license: z.string().min(1).max(200),
          })
          .strict(),
      )
      .length(2),
    files: z
      .array(
        z
          .object({ path: z.string().min(1).max(240), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict(),
      )
      .min(4)
      .max(500),
  })
  .strict();
async function regular(root: string, relative: string, limit: number) {
  if (
    relative.includes("\\") ||
    relative.startsWith("/") ||
    relative.split("/").some((p) => !p || p === "." || p === ".." || p.includes(":"))
  )
    throw new Error("Invalid design skill bundle path.");
  let current = root;
  for (const part of relative.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Invalid design skill bundle directory.");
  }
  const file = path.join(root, relative);
  const before = await fs.lstat(file);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > limit)
    throw new Error("Invalid design skill bundle file.");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > limit ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev
    )
      throw new Error("Design skill bundle changed during verification.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
/** Platform-owned, pinned read-only resources, never a path selected by generated project code. */
export async function verifyDesignSkillBundle(
  root = path.resolve(process.cwd(), "resources/design-skills"),
) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || root.includes(","))
    throw new Error("Invalid design skill bundle root.");
  const manifestBytes = await regular(root, "manifest.json", 256 * 1024);
  const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (new Set(manifest.skills.map((s) => s.id)).size !== 2)
    throw new Error("Design skills must be unique.");
  for (const skill of manifest.skills) {
    const url = new URL(skill.source);
    if (
      url.protocol !== "https:" ||
      !["github.com", "raw.githubusercontent.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid design skill source.");
  }
  const allowed = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    if (allowed.has(file.path) || file.path === "manifest.json")
      throw new Error("Duplicate design bundle path.");
    allowed.add(file.path);
    const bytes = await regular(root, file.path, 4 * 1024 * 1024);
    total += bytes.length;
    if (total > 24 * 1024 * 1024) throw new Error("Design skill bundle exceeds size limit.");
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
      throw new Error("Design skill bundle integrity mismatch.");
  }
  for (const id of ["ui-ux-pro-max", "frontend-design"])
    if (!allowed.has(id + "/SKILL.md")) throw new Error("Design skill instruction missing.");
  if (!allowed.has("ui-ux-pro-max/scripts/search.py"))
    throw new Error("Offline design search missing.");
  const walk = async (dir: string, prefix = ""): Promise<void> => {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix + item.name;
      if (item.isSymbolicLink()) throw new Error("Design skill bundle symlink rejected.");
      if (item.isDirectory()) await walk(path.join(dir, item.name), relative + "/");
      else if (!item.isFile() || (relative !== "manifest.json" && !allowed.has(relative)))
        throw new Error("Unreviewed design skill bundle file.");
    }
  };
  await walk(root);
  return {
    root: await fs.realpath(root),
    revision: createHash("sha256").update(manifestBytes).digest("hex"),
    skills: manifest.skills.map(({ id, revision }) => ({ id, revision })),
  };
}
