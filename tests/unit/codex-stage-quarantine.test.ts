import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inventoryWorkspace } from "@/server/agents/codex-assets";
import { quarantineGeneratedEnvironment } from "@/server/agents/codex-stage-quarantine";
describe("generated environment quarantine", () => {
  it("preserves generated env bytes outside worker, does not whitelist databases or credentials", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-quarantine-"));
    const stage = path.join(root, "stage");
    await fs.mkdir(stage);
    try {
      const baseline = await inventoryWorkspace(stage);
      await fs.mkdir(path.join(stage, "client"));
      await fs.writeFile(path.join(stage, "client/.env.development"), "VITE_API=/api\n");
      await fs.writeFile(path.join(stage, ".env.example"), "TOKEN=placeholder\n");
      await fs.writeFile(path.join(stage, "data.db"), "data");
      await fs.writeFile(path.join(stage, "auth.json"), "secret");
      expect(await quarantineGeneratedEnvironment(stage, baseline)).toEqual([
        "client/.env.development",
      ]);
      expect(await fs.readFile(path.join(stage, ".env.example"), "utf8")).toBe(
        "TOKEN=placeholder\n",
      );
      const after = await inventoryWorkspace(stage);
      expect(after.excluded).toEqual(["auth.json", "data.db"]);
      const [id] = await fs.readdir(path.join(root, "quarantined-environment"));
      expect(
        await fs.readFile(
          path.join(root, "quarantined-environment", id, "client/.env.development"),
          "utf8",
        ),
      ).toBe("VITE_API=/api\n");
      expect(await quarantineGeneratedEnvironment(stage, baseline)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
