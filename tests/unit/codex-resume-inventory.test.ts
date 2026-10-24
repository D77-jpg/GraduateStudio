import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertResumeInventoryAllowed } from "@/server/agents/codex-resume-inventory";
import { inventoryWorkspace, type WorkspaceInventory } from "@/server/agents/codex-assets";
import { snapshot, workspaceDiff } from "@/server/agents/codex-workspace";

let stage: string;
const empty = (): WorkspaceInventory => ({ hashes: {}, excluded: [], binary: [] });
beforeEach(async () => {
  stage = await fs.mkdtemp(path.join(os.tmpdir(), "gs-resume-inventory-"));
});
afterEach(async () => {
  await fs.rm(stage, { recursive: true, force: true });
});
async function generated(directory: string) {
  await fs.mkdir(path.join(stage, directory), { recursive: true });
  await fs.writeFile(path.join(stage, directory, "index.js"), "generated output");
}

describe("Codex read-only resume inventory policy", () => {
  it.each(["client/dist", "frontend/dist", "server/build", "backend/coverage", ".next", "dist"])(
    "allows exactly known build directory %s without applying its outputs",
    async (directory) => {
      await fs.writeFile(path.join(stage, "source.ts"), "original source");
      const baseline = await inventoryWorkspace(stage);
      const before = await snapshot(stage);
      await generated(directory);
      const copied = await inventoryWorkspace(stage);
      expect(copied.excluded).toEqual([directory]);
      await expect(assertResumeInventoryAllowed(stage, baseline, copied)).resolves.toBeUndefined();
      expect(copied.hashes).toEqual(baseline.hashes);
      expect(workspaceDiff(before, await snapshot(stage), false)).toEqual([]);
      expect(await fs.readFile(path.join(stage, directory, "index.js"), "utf8")).toBe(
        "generated output",
      );
    },
  );

  it.each([
    ".env",
    "client/.env.production",
    "malicious.env",
    "data.db",
    "server/private.sqlite",
    "auth.json",
    "credentials.json",
    ".git",
    "tmp",
    "tmp/dist",
    "client/dist/foo",
    "client/../dist",
    "client\\dist",
    "/client/dist",
    "client/dist/",
    "server/target",
  ])("rejects a new excluded path %s instead of broadening secrets/data rules", async (file) => {
    await expect(
      assertResumeInventoryAllowed(stage, empty(), { ...empty(), excluded: [file] }),
    ).rejects.toThrow("未经允许");
  });

  it("rejects actual newly created secrets and database files", async () => {
    const baseline = await inventoryWorkspace(stage);
    await fs.writeFile(path.join(stage, ".env.malicious"), "DO_NOT_READ=private");
    await fs.writeFile(path.join(stage, "data.db"), "private database");
    const copied = await inventoryWorkspace(stage);
    expect(copied.excluded).toEqual(expect.arrayContaining([".env.malicious", "data.db"]));
    await expect(assertResumeInventoryAllowed(stage, baseline, copied)).rejects.toThrow("未经允许");
  });

  it("preserves baseline exclusions and the existing node_modules exception without mutation", async () => {
    const baseline = { ...empty(), excluded: [".env", "data.db"] };
    const copied = { ...empty(), excluded: [".env", "data.db", "client/node_modules"] };
    const original = structuredClone({ baseline, copied });
    await expect(assertResumeInventoryAllowed(stage, baseline, copied)).resolves.toBeUndefined();
    expect({ baseline, copied }).toEqual(original);
  });

  it("does not excuse changed binary source just because a build directory is present", async () => {
    await generated("client/dist");
    await expect(
      assertResumeInventoryAllowed(
        stage,
        { hashes: { "image.bin": "old" }, excluded: [], binary: ["image.bin"] },
        { hashes: { "image.bin": "new" }, excluded: ["client/dist"], binary: ["image.bin"] },
      ),
    ).rejects.toThrow("二进制");
  });

  it("rejects a regular file named dist rather than treating it as a generated directory", async () => {
    await fs.mkdir(path.join(stage, "client"));
    await fs.writeFile(path.join(stage, "client/dist"), "not a directory");
    await expect(
      assertResumeInventoryAllowed(stage, empty(), await inventoryWorkspace(stage)),
    ).rejects.toThrow("真实目录");
  });

  it("rejects symlinked build directories and links hidden inside excluded build output", async () => {
    const target = path.join(stage, "actual");
    await fs.mkdir(target);
    await fs.mkdir(path.join(stage, "client"));
    await fs.symlink(target, path.join(stage, "client/dist"), "junction");
    await expect(inventoryWorkspace(stage)).rejects.toThrow("符号链接");
    await expect(
      assertResumeInventoryAllowed(stage, empty(), { ...empty(), excluded: ["client/dist"] }),
    ).rejects.toThrow("真实目录");
    await fs.unlink(path.join(stage, "client/dist"));
    await generated("client/dist");
    await fs.symlink(target, path.join(stage, "client/dist/link"), "junction");
    await expect(
      assertResumeInventoryAllowed(stage, empty(), await inventoryWorkspace(stage)),
    ).rejects.toThrow("符号链接或硬链接");
  });

  it("rejects real hard links both in inventoried source and hidden build output", async () => {
    const original = path.join(stage, "original.txt");
    await fs.writeFile(original, "source");
    await fs.link(original, path.join(stage, "linked.txt"));
    await expect(inventoryWorkspace(stage)).rejects.toThrow("硬链接");
    await fs.unlink(path.join(stage, "linked.txt"));
    await generated("client/dist");
    await fs.link(original, path.join(stage, "client/dist/link.txt"));
    await expect(
      assertResumeInventoryAllowed(stage, empty(), { ...empty(), excluded: ["client/dist"] }),
    ).rejects.toThrow("符号链接或硬链接");
  });

  it("does not silently reclassify server/target files as excluded or safe output", async () => {
    await generated("server/target");
    const inventory = await inventoryWorkspace(stage);
    expect(inventory.excluded).toEqual([]);
    expect(Object.keys(inventory.hashes)).toEqual(["server/target/index.js"]);
    expect([...(await snapshot(stage)).keys()]).toEqual(["server/target/index.js"]);
  });

  it("treats server/target as build output only once a Maven marker sits beside it", async () => {
    await fs.mkdir(path.join(stage, "server"), { recursive: true });
    await fs.writeFile(path.join(stage, "server", "pom.xml"), "<project/>");
    await generated("server/target");
    const inventory = await inventoryWorkspace(stage);
    expect(inventory.excluded).toEqual(["server/target"]);
    expect(Object.keys(inventory.hashes)).toEqual(["server/pom.xml"]);
    expect([...(await snapshot(stage)).keys()]).toEqual(["server/pom.xml"]);
    await expect(assertResumeInventoryAllowed(stage, empty(), inventory)).resolves.toBeUndefined();
  });
});
