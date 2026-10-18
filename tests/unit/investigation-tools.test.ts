import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeInvestigationTool,
  investigationToolRequestSchema,
  type InvestigationToolRequest,
} from "@/server/agents/investigation-tools";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "investigation-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await fs.writeFile(path.join(root, "notes.txt"), "first\nliteral .* query\nthird\n");
  return root;
}
async function execute(root: string, request: InvestigationToolRequest, signal?: AbortSignal) {
  return (await executeInvestigationTool(root, request, signal)) as {
    tool: string;
    ok: boolean;
    text: string;
    entries: Array<{ path: string }>;
    hits: unknown[];
    output: string;
    linesReturned: number;
    truncated?: boolean;
    exitCode?: number | null;
    blockedReason?: string;
    durationMs?: number;
  };
}

describe("bounded investigation tools", () => {
  it("exports a strict discriminated request schema with bounded defaults", () => {
    expect(investigationToolRequestSchema.parse({ tool: "read_file", path: "notes.txt" })).toEqual({
      tool: "read_file",
      path: "notes.txt",
      offset: 1,
      limit: 200,
    });
    expect(
      investigationToolRequestSchema.safeParse({ tool: "read_file", path: "x", limit: 201 })
        .success,
    ).toBe(false);
    expect(
      investigationToolRequestSchema.safeParse({
        tool: "node_test",
        directory: "client",
        testPath: "tests/a.test.js",
      }).success,
    ).toBe(false);
    expect(
      investigationToolRequestSchema.safeParse({
        tool: "node_test",
        directory: "backend",
        testPath: "tests/a.test.js",
        args: ["--test-skip-pattern", ".*"],
      }).success,
    ).toBe(false);
    expect(
      investigationToolRequestSchema.safeParse({ tool: "shell", command: "echo x" }).success,
    ).toBe(false);
  });

  it.each([
    "../notes.txt",
    "backend/../notes.txt",
    "/notes.txt",
    "C:\\notes.txt",
    "\\\\server\\file",
    ".env",
    ".env.test.local",
    "backend/.ENV.production",
    ".git/config",
    "node_modules/x",
    "dist/x",
    "backend/private.key",
    "backend/secrets.json",
    "backend/notes.txt:stream",
  ])("rejects traversal, absolute paths and protected paths: %s", async (file) => {
    expect(await execute(await fixture(), { tool: "read_file", path: file })).toMatchObject({
      ok: false,
      tool: "read_file",
      blockedReason: expect.any(String),
    });
  });

  it("rejects symlinked path components and root, while listing/search omit links and secrets", async () => {
    const root = await fixture();
    const outside = await fixture();
    await fs.symlink(outside, path.join(root, "linked"), "junction");
    await fs.writeFile(path.join(root, ".env.production"), "literal .* query SECRET");
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(path.join(root, "dist", "hidden.txt"), "literal .* query");
    expect(await execute(root, { tool: "read_file", path: "linked/notes.txt" })).toMatchObject({
      ok: false,
    });
    expect(await execute(root, { tool: "list_files", directory: "linked" })).toMatchObject({
      ok: false,
    });
    expect(await execute(path.join(root, "linked"), { tool: "list_files" })).toMatchObject({
      ok: false,
    });
    expect(
      await execute(path.join(root, "linked", "backend"), { tool: "list_files" }),
    ).toMatchObject({ ok: false });
    const listing = await execute(root, { tool: "list_files" });
    expect(listing.ok).toBe(true);
    expect(listing.entries.map((entry: { path: string }) => entry.path).sort()).toEqual([
      "backend",
      "notes.txt",
    ]);
    const search = await execute(root, { tool: "search_text", query: "literal .* query" });
    expect(search.hits).toEqual([{ path: "notes.txt", line: 2, text: "literal .* query" }]);
  });

  it("reads complete requested lines with numbers and bounded output", async () => {
    const root = await fixture();
    const result = await execute(root, {
      tool: "read_file",
      path: "notes.txt",
      offset: 2,
      limit: 2,
    });
    expect(result.text).toBe("2: literal .* query\n3: third\n");
    await fs.writeFile(
      path.join(root, "large.txt"),
      Array.from({ length: 500 }, (_, i) => `${i}:${"x".repeat(200)}`).join("\n"),
    );
    const large = await execute(root, { tool: "read_file", path: "large.txt" });
    expect(large.text.length).toBeLessThanOrEqual(16_000);
    expect(large.linesReturned).toBeLessThanOrEqual(200);
    expect(large.truncated).toBe(true);
    await fs.writeFile(path.join(root, "binary.txt"), "a\0b");
    expect(await execute(root, { tool: "read_file", path: "binary.txt" })).toMatchObject({
      ok: false,
    });
  });

  it("caps large file reads and literal search result counts", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "big.txt"), "x".repeat(600_000));
    expect(await execute(root, { tool: "read_file", path: "big.txt" })).toMatchObject({
      truncated: true,
    });
    await fs.writeFile(path.join(root, "matches.txt"), "needle\n".repeat(300));
    const result = await execute(root, { tool: "search_text", query: "needle" });
    expect(result.hits).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.hits).length).toBeLessThanOrEqual(16_000);
  });

  it.each([
    "../notes.test.cjs",
    "tests/../../notes.test.cjs",
    "tests/no.test.ts",
    "tests/no.test.cjs",
    "--test",
    "tests/a.test.cjs --test-skip-pattern=x",
  ])("blocks invalid/non-existing single test path: %s", async (testPath) => {
    expect(
      await execute(await fixture(), { tool: "node_test", directory: "backend", testPath }),
    ).toMatchObject({ ok: false });
  });

  it("runs only the selected real Node test with local connection config and no preload flags", async () => {
    const root = await fixture();
    vi.stubEnv("TEST_DB_NAME", undefined);
    vi.stubEnv("NODE_OPTIONS", "--require nonexistent-preload");
    await fs.writeFile(
      path.join(root, ".env.test.local"),
      "TEST_DB_NAME=investigation_fixture_test\n",
    );
    const selected =
      "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('selected actual assertion',()=>{assert.equal(2+2,4);assert.equal(process.env.TEST_DB_NAME,'investigation_fixture_test');assert.equal(process.env.NODE_OPTIONS,undefined);});";
    await fs.writeFile(path.join(root, "backend", "tests", "selected.test.cjs"), selected);
    await fs.writeFile(
      path.join(root, "backend", "tests", "other.test.cjs"),
      "throw new Error('must not run other test');",
    );
    const result = await execute(root, {
      tool: "node_test",
      directory: "backend",
      testPath: "tests/selected.test.cjs",
    });
    expect(result).toMatchObject({ tool: "node_test", ok: true, exitCode: 0 });
    expect(result.output).toContain("selected actual assertion");
    expect(result.output).not.toContain("must not run other test");
    expect(
      await fs.readFile(path.join(root, "backend", "tests", "selected.test.cjs"), "utf8"),
    ).toBe(selected);
  }, 10_000);

  it("reports a real assertion failure without converting it to success", async () => {
    const root = await fixture();
    await fs.writeFile(
      path.join(root, "backend", "tests", "fail.test.cjs"),
      "const {test}=require('node:test');test('real failure',()=>{throw new Error('actual failing assertion')});",
    );
    const result = await execute(root, {
      tool: "node_test",
      directory: "backend",
      testPath: "tests/fail.test.cjs",
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("actual failing assertion");
  }, 10_000);

  it("does not call skipped or empty tests successful", async () => {
    const root = await fixture();
    await fs.writeFile(
      path.join(root, "backend", "tests", "skip.test.cjs"),
      "require('node:test').test.skip('not actual coverage',()=>{});",
    );
    const result = await execute(root, {
      tool: "node_test",
      directory: "backend",
      testPath: "tests/skip.test.cjs",
    });
    expect(result).toMatchObject({
      ok: false,
      exitCode: 0,
      blockedReason: expect.stringContaining("real passing tests"),
    });
  }, 10_000);

  it("blocks unsafe local environment without executing a test", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, ".env.test.local"), "NODE_OPTIONS=--require evil\n");
    await fs.writeFile(
      path.join(root, "backend", "tests", "safe.test.cjs"),
      "console.log('SHOULD NOT EXECUTE');",
    );
    const result = await execute(root, {
      tool: "node_test",
      directory: "backend",
      testPath: "tests/safe.test.cjs",
    });
    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      blockedReason: expect.stringContaining("configuration"),
    });
    expect(result.output).toBeUndefined();
  });

  it("bounds listing and test output", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "many"));
    await Promise.all(
      Array.from({ length: 210 }, (_, index) =>
        fs.writeFile(path.join(root, "many", `${index}.txt`), "x"),
      ),
    );
    expect(await execute(root, { tool: "list_files", directory: "many" })).toMatchObject({
      truncated: true,
      entries: expect.any(Array),
    });
    await fs.writeFile(
      path.join(root, "backend", "tests", "verbose.test.cjs"),
      "require('node:test').test('verbose',()=>console.log('x'.repeat(50000)));",
    );
    const result = await execute(root, {
      tool: "node_test",
      directory: "backend",
      testPath: "tests/verbose.test.cjs",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeLessThanOrEqual(16_000);
    expect(result.truncated).toBe(true);
  }, 10_000);

  it("rejects a symlinked tests ancestor", async () => {
    const root = await fixture();
    const outside = await fixture();
    await fs.writeFile(
      path.join(outside, "backend", "tests", "linked.test.cjs"),
      "throw new Error('must not execute');",
    );
    await fs.rm(path.join(root, "backend", "tests"), { recursive: true });
    await fs.symlink(
      path.join(outside, "backend", "tests"),
      path.join(root, "backend", "tests"),
      "junction",
    );
    expect(
      await execute(root, {
        tool: "node_test",
        directory: "backend",
        testPath: "tests/linked.test.cjs",
      }),
    ).toMatchObject({ ok: false, blockedReason: expect.any(String) });
  });

  it("terminates on its fixed timeout without waiting 30 seconds in the test", async () => {
    const root = await fixture();
    await fs.writeFile(
      path.join(root, "backend", "tests", "timeout.test.cjs"),
      "setInterval(()=>{},1000);",
    );
    const originalTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        originalTimeout(callback, delay === 29_000 ? 100 : delay, ...args)) as typeof setTimeout);
    try {
      const result = await execute(root, {
        tool: "node_test",
        directory: "backend",
        testPath: "tests/timeout.test.cjs",
      });
      expect(result).toMatchObject({
        ok: false,
        blockedReason: expect.stringContaining("30000ms"),
      });
      expect(spy.mock.calls.some((call) => call[1] === 29_000)).toBe(true);
      expect(result.durationMs).toBeLessThan(5_000);
    } finally {
      spy.mockRestore();
    }
  }, 10_000);

  it("handles pre-aborted requests and aborts a running process tree promptly", async () => {
    const root = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await execute(root, { tool: "list_files" }, controller.signal)).toMatchObject({
      ok: false,
      blockedReason: expect.stringContaining("aborted"),
    });
    await fs.writeFile(
      path.join(root, "backend", "tests", "hang.test.cjs"),
      "require('node:test').test('hang',async()=>await new Promise(()=>{}));setInterval(()=>{},1000);",
    );
    const active = new AbortController();
    const timer = setTimeout(() => active.abort(), 400);
    try {
      const result = await execute(
        root,
        { tool: "node_test", directory: "backend", testPath: "tests/hang.test.cjs" },
        active.signal,
      );
      expect(result).toMatchObject({
        ok: false,
        blockedReason: expect.stringContaining("aborted"),
      });
      expect(result.durationMs).toBeLessThan(5_000);
    } finally {
      clearTimeout(timer);
    }
  }, 10_000);
});
