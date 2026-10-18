import { afterEach, describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { verifyDesignSkillBundle } from "@/server/agents/design-skill-bundle";
const dirs: string[] = [];
afterEach(async () => {
  for (const p of dirs.splice(0)) await fs.rm(p, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-design-bundle-"));
  dirs.push(root);
  const files = [];
  for (const p of [
    "ui-ux-pro-max/SKILL.md",
    "ui-ux-pro-max/scripts/search.py",
    "frontend-design/SKILL.md",
    "LICENSE.txt",
  ]) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fs.writeFile(path.join(root, p), "reviewed");
    files.push({ path: p, sha256: createHash("sha256").update("reviewed").digest("hex") });
  }
  const manifest = {
    version: 1,
    skills: [
      {
        id: "ui-ux-pro-max",
        revision: "a".repeat(40),
        source: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
        license: "MIT",
      },
      {
        id: "frontend-design",
        revision: "b".repeat(40),
        source: "https://github.com/anthropics/skills",
        license: "Apache-2.0",
      },
    ],
    files,
  };
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, manifest };
}
describe("pinned read-only design skill bundle", () => {
  it("validates every file and returns resource revisions without executing scripts", async () => {
    const { root } = await fixture();
    const b = await verifyDesignSkillBundle(root);
    expect(b.skills).toHaveLength(2);
    expect(b.revision).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects modified reviewed bytes", async () => {
    const { root } = await fixture();
    await fs.writeFile(path.join(root, "frontend-design/SKILL.md"), "tampered");
    await expect(verifyDesignSkillBundle(root)).rejects.toThrow("integrity");
  });
  it("rejects files outside the reviewed manifest", async () => {
    const { root } = await fixture();
    await fs.writeFile(path.join(root, "unreviewed.py"), "bad");
    await expect(verifyDesignSkillBundle(root)).rejects.toThrow("Unreviewed");
  });
  it("rejects manifest path traversal", async () => {
    const { root, manifest } = await fixture();
    manifest.files[0].path = "../SKILL.md";
    await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
    await expect(verifyDesignSkillBundle(root)).rejects.toThrow("path");
  });
  it("rejects nonofficial source URL hosts", async () => {
    const { root, manifest } = await fixture();
    manifest.skills[0].source = "https://untrusted.example/repo";
    await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
    await expect(verifyDesignSkillBundle(root)).rejects.toThrow("source");
  });
});
