import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inventoryWorkspace,
  assertBinaryUnchanged,
  assertInventoryUnchanged,
} from "@/server/agents/codex-assets";
describe("Codex asset inventory", () => {
  it("ignores Python check caches on resume without hiding real source or binary changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-python-cache-"));
    try {
      await fs.writeFile(path.join(root, "app.py"), "print('你好')\n");
      const before = await inventoryWorkspace(root);
      for (const name of ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]) {
        await fs.mkdir(path.join(root, name));
        await fs.writeFile(path.join(root, name, "cache.pyc"), Buffer.from([0, 1, 2]));
      }
      await fs.writeFile(path.join(root, "app.pyc"), Buffer.from([0, 1]));
      const after = await inventoryWorkspace(root);
      expect(after).toEqual(before);
      expect(() => assertBinaryUnchanged(before, after)).not.toThrow();
      const { snapshot } = await import("@/server/agents/codex-workspace");
      expect([...(await snapshot(root))].map(([file]) => file)).toEqual(["app.py"]);
      await fs.writeFile(path.join(root, "asset.bin"), Buffer.from([0, 1]));
      expect(() =>
        assertBinaryUnchanged(before, {
          ...after,
          binary: ["asset.bin"],
          hashes: { ...after.hashes, "asset.bin": "changed" },
        }),
      ).toThrow("asset.bin");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("inventories special object-property filenames and detects their changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-assets-special-"));
    try {
      await fs.writeFile(path.join(root, "__proto__"), "original");
      await fs.writeFile(path.join(root, "constructor"), "constructor file");
      const before = await inventoryWorkspace(root);
      expect(Object.prototype.hasOwnProperty.call(before.hashes, "__proto__")).toBe(true);
      expect(Object.keys(before.hashes)).toEqual(
        expect.arrayContaining(["__proto__", "constructor"]),
      );
      await fs.writeFile(path.join(root, "__proto__"), "changed");
      const after = await inventoryWorkspace(root);
      expect(() => assertInventoryUnchanged(before, after, "conflict")).toThrow("__proto__");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("copies binary assets but excludes secrets and dependencies explicitly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-assets-"));
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), "gs-assets-out-"));
    try {
      await fs.writeFile(path.join(root, "icon.png"), Buffer.from([0, 1, 2]));
      await fs.writeFile(path.join(root, ".env"), "SECRET");
      await fs.writeFile(path.join(root, "data.db"), "database");
      await fs.mkdir(path.join(root, "node_modules"));
      const inv = await inventoryWorkspace(root, dest);
      expect(inv.binary).toEqual(["icon.png"]);
      expect(inv.excluded).toEqual(expect.arrayContaining([".env", "data.db", "node_modules"]));
      expect(await fs.readFile(path.join(dest, "icon.png"))).toEqual(Buffer.from([0, 1, 2]));
      await fs.writeFile(path.join(root, "icon.png"), Buffer.from([0, 1, 3]));
      const after = await inventoryWorkspace(root);
      expect(() => assertBinaryUnchanged(inv, after)).toThrow("二进制");
      expect(() => assertInventoryUnchanged(inv, after, "冲突")).toThrow("冲突");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});
