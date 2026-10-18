import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acceptanceTestEnvironment } from "@/server/agents/acceptance-environment";
import { executeAcceptanceCommand } from "@/server/agents/acceptance";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(content?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acceptance-env-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "backend", "tests"), { recursive: true });
  if (content !== undefined) await fs.writeFile(path.join(root, ".env.test.local"), content);
  return root;
}
describe("local acceptance database environment", () => {
  it("leaves inherited configuration unchanged without a local file", async () => {
    const root = await fixture();
    expect(
      await acceptanceTestEnvironment(path.join(root, "backend"), {
        PATH: "original",
        NODE_ENV: "test",
      }),
    ).toEqual({ PATH: "original", NODE_ENV: "test" });
  });
  it("loads connection values without expansion and gives process configuration precedence", async () => {
    const root = await fixture(
      '# local\nTEST_DB_HOST=127.0.0.1\nTEST_DB_PASSWORD="${SECRET} literal"\nTEST_DB_NAME=campus_activity_test\n',
    );
    const env = await acceptanceTestEnvironment(path.join(root, "backend"), {
      NODE_ENV: "test",
      TEST_DB_HOST: "ci-db",
    });
    expect(env.TEST_DB_HOST).toBe("ci-db");
    expect(env.TEST_DB_PASSWORD).toBe("${SECRET} literal");
  });
  it.each([
    "NODE_OPTIONS=--require evil",
    "TEST_DB_REQUIRE=0",
    "TEST_DB_ISOLATE=0",
    "TEST_DB_KEEP=1",
    "TEST_DB_NAME=campus_activity",
    'TEST_DB_PASSWORD="unclosed',
  ])("rejects unsafe configuration: %s", async (content) => {
    const root = await fixture(content);
    await expect(
      acceptanceTestEnvironment(path.join(root, "backend"), { NODE_ENV: "test" }),
    ).rejects.toThrow();
  });
  it("blocks oversized configuration", async () => {
    const root = await fixture("#".repeat(8193));
    await expect(
      acceptanceTestEnvironment(path.join(root, "backend"), { NODE_ENV: "test" }),
    ).rejects.toThrow("8KiB");
  });
  it("passes local connection configuration to the original Node test command", async () => {
    const root = await fixture("TEST_DB_NAME=acceptance_fixture_test\n");
    await fs.writeFile(
      path.join(root, "backend", "tests", "env.test.cjs"),
      "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('env',()=>assert.equal(process.env.TEST_DB_NAME,'acceptance_fixture_test')); ",
    );
    const result = await executeAcceptanceCommand(
      {
        id: "backend-test",
        label: "fixture",
        tool: "node",
        args: ["--test"],
        directory: "backend",
        timeoutMs: 10000,
      },
      path.join(root, "backend"),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("TEST_DB_PASSWORD");
  });
});
