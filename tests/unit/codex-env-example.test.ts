import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isSafeEnvExample,
  readSafeEnvExample,
  ENV_EXAMPLE_LIMIT,
} from "@/server/agents/codex-env-example";
import { inventoryWorkspace, assertInventoryUnchanged } from "@/server/agents/codex-assets";
import { snapshot, workspaceDiff } from "@/server/agents/codex-workspace";
import { quarantineGeneratedEnvironment } from "@/server/agents/codex-stage-quarantine";

const safe =
  "# Example environment configuration\nSECRET_KEY=please-change-secret-key\nDATABASE_URL=mysql+pymysql://placeholder:please-change-database-password@localhost:3306/example?charset=utf8mb4\nREDIS_URL=redis://localhost:6379/0\nAPP_ENV=development\nMYSQL_PORT=3306\nMYSQL_USER=placeholder\nVITE_API_BASE_URL=/api\nUPLOAD_DIR=var/uploads\n";
describe("strict safe environment examples", () => {
  it("allows only placeholders and narrowly recognized non-credential configuration", () => {
    expect(isSafeEnvExample(Buffer.from(safe))).toBe(true);
    expect(isSafeEnvExample(Buffer.from("TOKEN=\nPASSWORD=<password>\nDEBUG=false\n"))).toBe(true);
  });
  it.each([
    "TOKEN=sk-real-secret",
    "API_KEY=real-secret",
    "MYSQL_PASSWORD=production123",
    "SECRET_KEY=http://localhost",
    "AUTH=production",
    "SOMETHING=hidden-secret",
    "DATABASE_URL=mysql://placeholder:real-password@localhost/example",
    "DATABASE_URL=mysql://real-user:placeholder@localhost/example",
    "DATABASE_URL=mysql://placeholder:%72eal-password@localhost/example",
    "DATABASE_URL=mysql://placeholder:placeholder@remote.example/example",
    "API_URL=https://localhost/api?token=secret",
    "API_URL=http://localhost/api#secret",
    "API_URL=http://localhost/encoded%73ecret",
    "API_URL=http://localhost/secret12345",
    "API_URL=http://localhost/realsecret",
    "API_URL=http://localhost/realsecret/../api",
    "API_URL=http://localhost/\tapi",
    "API_URL=http://localhost/%61pi",
    "DATABASE_URL=mysql://placeholder:place%68older@localhost/example",
    "CORS_ORIGINS=https://attacker.example",
    "PORT=65536",
    "PORT=123secret",
    "# TOKEN=real-secret",
    "# arbitrary real-secret",
    "export TOKEN=placeholder",
    'TOKEN="placeholder"',
    "TOKEN=${REAL_TOKEN}",
    "TOKEN=$(cat /secret)",
    "TOKEN=placeholder # actual-secret",
    "TOKEN=placeholder\nTOKEN=real-secret",
    "TOKEN=placeholder\nnot-an-assignment",
    "token=placeholder",
    "TOKEN=placeholder\u0000",
    "TOKEN=placeholder\u001b[31m",
    "TOKEN=placeholder\u202esecret",
    "TOKEN=please-change-real-secret-abcdef",
    "VITE_APP_TITLE=real-secret",
  ])("rejects unsafe or ambiguous content without rewriting it: %s", (text) => {
    expect(isSafeEnvExample(Buffer.from(text))).toBe(false);
  });
  it("rejects invalid UTF8 and oversized content", () => {
    expect(isSafeEnvExample(Buffer.from([0xff]))).toBe(false);
    expect(isSafeEnvExample(Buffer.alloc(ENV_EXAMPLE_LIMIT + 1, 32))).toBe(false);
  });
  it("copies and diffs safe examples but excludes and quarantines unsafe examples and all other env names", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-env-safe-"));
    const stage = path.join(root, "stage"),
      dest = path.join(root, "copy");
    await fs.mkdir(stage);
    await fs.mkdir(dest);
    try {
      const baseline = await inventoryWorkspace(stage);
      await fs.mkdir(path.join(stage, "server"));
      await fs.writeFile(path.join(stage, ".env.example"), safe);
      await fs.writeFile(path.join(stage, "server/.env.example"), "TOKEN=real-secret");
      for (const name of [".env", ".env.local", ".env.example.bak"])
        await fs.writeFile(path.join(stage, name), "TOKEN=placeholder");
      const inv = await inventoryWorkspace(stage, dest);
      expect(Object.keys(inv.hashes)).toEqual([".env.example"]);
      expect(await fs.readdir(dest)).toEqual([".env.example"]);
      expect([...(await snapshot(stage))]).toEqual([[".env.example", safe]]);
      expect(workspaceDiff(new Map(), await snapshot(stage), false)).toEqual([
        { path: ".env.example", action: "create", content: safe },
      ]);
      const quarantined = await quarantineGeneratedEnvironment(stage, baseline);
      expect(quarantined).toContain("server/.env.example");
      expect(quarantined).not.toContain(".env.example");
      const [id] = await fs.readdir(path.join(root, "quarantined-environment"));
      expect(
        await fs.readFile(
          path.join(root, "quarantined-environment", id, "server/.env.example"),
          "utf8",
        ),
      ).toBe("TOKEN=real-secret");
      expect(await fs.readFile(path.join(stage, ".env.example"), "utf8")).toBe(safe);
      await fs.writeFile(path.join(stage, ".env.example"), "TOKEN=real-secret");
      const changed = await inventoryWorkspace(stage);
      expect(() => assertInventoryUnchanged(inv, changed, "changed")).toThrow(".env.example");
      expect([...(await snapshot(stage))]).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("never accepts other basenames, directories, or oversized files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gs-env-invalid-"));
    try {
      await fs.writeFile(path.join(root, ".env"), "TOKEN=placeholder");
      expect(await readSafeEnvExample(path.join(root, ".env"))).toBeNull();
      // Case-only aliases cannot coexist with .env.example on Windows.
      await fs.writeFile(path.join(root, ".ENV.EXAMPLE"), "TOKEN=placeholder");
      expect(await readSafeEnvExample(path.join(root, ".ENV.EXAMPLE"))).toBeNull();
      expect((await inventoryWorkspace(root)).hashes).toEqual({});
      expect((await snapshot(root)).size).toBe(0);
      await fs.rm(path.join(root, ".ENV.EXAMPLE"));
      await fs.mkdir(path.join(root, ".env.example"));
      expect(await readSafeEnvExample(path.join(root, ".env.example"))).toBeNull();
      expect((await inventoryWorkspace(root)).excluded).toContain(".env.example");
      expect((await snapshot(root)).size).toBe(0);
      await fs.rm(path.join(root, ".env.example"), { recursive: true });
      await fs.writeFile(path.join(root, ".env.example"), Buffer.alloc(ENV_EXAMPLE_LIMIT + 1, 32));
      expect(await readSafeEnvExample(path.join(root, ".env.example"))).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
