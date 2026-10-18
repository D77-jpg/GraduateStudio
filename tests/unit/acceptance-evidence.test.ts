import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AcceptanceEvidenceCollector,
  ACCEPTANCE_EVIDENCE_BYTE_LIMIT,
  ACCEPTANCE_EVIDENCE_INCOMPLETE_MARKER,
  MYSQL_ENVIRONMENT_BLOCKED_REASON,
} from "@/server/agents/acceptance-evidence";
import {
  executeAcceptanceCommand,
  runProjectAcceptance,
  ACCEPTANCE_OUTPUT_LIMIT,
} from "@/server/agents/acceptance";
import type { AcceptanceCommand } from "@/lib/acceptance";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const command: AcceptanceCommand = {
  id: "backend-test",
  label: "Temporary Node fixture",
  directory: "backend",
  tool: "node",
  args: ["--test"],
  timeoutMs: 10_000,
};
async function fixture(source: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acceptance-evidence-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await fs.writeFile(
    path.join(root, "backend", "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );
  await fs.writeFile(path.join(root, "backend", "tests", "fixture.test.cjs"), source);
  return root;
}
function collect(text: string) {
  const collector = new AcceptanceEvidenceCollector();
  collector.write("stdout", Buffer.from(text));
  return collector.finish();
}

describe("streaming acceptance failure evidence", () => {
  it("ignores early named failures and collects every final Node section without a semantic cap", () => {
    const final = Array.from(
      { length: 30 },
      (_, i) =>
        `test at tests\\contract.test.js:${i + 1}:1\n✖ contract ${i}\n  AssertionError: assertion-${i}\n    at TestContext.<anonymous> (tests\\contract.test.js:${i + 1}:1)`,
    ).join("\n\n");
    const result = collect(`✖ initial named failure (1ms)\nnoise\nℹ failing tests:\n${final}`);
    expect(result.failureEvidence).not.toContain("initial named failure");
    for (let i = 0; i < 30; i++)
      expect(result.failureEvidence).toContain(`AssertionError: assertion-${i}`);
    expect(result.failureEvidenceIncomplete).toBeUndefined();
  });
  it("decodes split UTF-8 and CRLF separately per pipe, including unterminated final lines", () => {
    const collector = new AcceptanceEvidenceCollector();
    const stdout = Buffer.from(
      "test at tests\\a.js:1:1\r\n✖ 中文契约\r\n  AssertionError: 中文错误",
    );
    const stderr = Buffer.from("FAIL tests/b.test.ts > second\r\nAssertionError: 第二个错误\r\n");
    for (let i = 0; i < Math.max(stdout.length, stderr.length); i++) {
      if (i < stdout.length) collector.write("stdout", stdout.subarray(i, i + 1));
      if (i < stderr.length) collector.write("stderr", stderr.subarray(i, i + 1));
    }
    const result = collector.finish();
    expect(result.failureEvidence).toContain("✖ 中文契约");
    expect(result.failureEvidence).toContain("AssertionError: 中文错误");
    expect(result.failureEvidence).toContain("AssertionError: 第二个错误");
    expect(result.failureEvidence).not.toContain("�");
  });
  it("captures TAP not-ok diagnostics and YAML stacks but not passing noise", () => {
    const result = collect(
      "TAP version 13\n# Subtest: broken\nnot ok 1 - broken\n  ---\n  error: 'expected 2 got 1'\n  stack: |-\n    TestContext.<anonymous> (tests/a.js:4:2)\n  ...\n# passing progress\nok 2 - works\n",
    );
    expect(result.failureEvidence).toContain("expected 2 got 1");
    expect(result.failureEvidence).toContain("tests/a.js:4:2");
    expect(result.failureEvidence).not.toContain("passing progress");
    expect(result.failureEvidence).not.toContain("ok 2 - works");
  });
  it("captures complete Vitest FAIL sections until separators, ignoring progress", () => {
    const result = collect(
      " ❯ progress.test.ts (3 tests | 1 failed)\n FAIL tests/a.test.ts > contract\nAssertionError: mismatch\nExpected: 5\nReceived: 2\n ❯ progress-only (2 tests | 1 failed)\n ❯ tests/a.test.ts:5:2\n at src/a.ts:8:2\n⎯⎯⎯⎯ [1/2] ⎯⎯\n FAIL tests/b.test.ts > other\nError: other failure\n⎯⎯⎯⎯\n Tests 2 failed\n",
    );
    expect(result.failureEvidence).toContain("Expected: 5\nReceived: 2");
    expect(result.failureEvidence).toContain("src/a.ts:8:2");
    expect(result.failureEvidence).toContain("❯ tests/a.test.ts:5:2");
    expect(result.failureEvidence).toContain("other failure");
    expect(result.failureEvidence).not.toContain("progress-only");
    expect(result.failureEvidence).not.toContain("Tests 2 failed");
  });
  it.each(["lines", "bytes", "single-line"])("marks %s safety overflow explicitly", (kind) => {
    const payload =
      kind === "lines"
        ? "detail\n".repeat(4200)
        : kind === "bytes"
          ? `${"é".repeat(1000)}\n`.repeat(600)
          : "x".repeat(ACCEPTANCE_EVIDENCE_BYTE_LIMIT + 1);
    const result = collect(`test at tests/a.js:1:1\n✖ broken\n${payload}`);
    expect(result.failureEvidenceIncomplete).toBe(true);
    expect(result.failureEvidence).toContain(ACCEPTANCE_EVIDENCE_INCOMPLETE_MARKER);
    expect(Buffer.byteLength(result.failureEvidence!, "utf8")).toBeLessThanOrEqual(
      ACCEPTANCE_EVIDENCE_BYTE_LIMIT,
    );
  });
  it("detects clear MySQL blockers in the middle of full incoming logs only", () => {
    const collector = new AcceptanceEvidenceCollector();
    collector.write("stderr", Buffer.from("x".repeat(30000) + "\n集成测试无法连接 MySQL: ENOT"));
    collector.write("stderr", Buffer.from("FOUND mysql\n" + "x".repeat(30000)));
    expect(collector.finish().environmentBlockedReason).toBe(MYSQL_ENVIRONMENT_BLOCKED_REASON);
    expect(
      collect("AssertionError: expected db to throw ENOTFOUND").environmentBlockedReason,
    ).toBeUndefined();
    expect(collect("Error: getaddrinfo ENOTFOUND db").environmentBlockedReason).toBe(
      MYSQL_ENVIRONMENT_BLOCKED_REASON,
    );
  });
  it.each([
    "Access denied for user 'tester' to database 'campus_activity_test_p123'",
    "ER_ACCESS_DENIED_ERROR",
    "Connection lost: The server closed the connection.",
  ])("classifies explicit MySQL setup failure as blocked: %s", (reason) => {
    expect(
      collect(`无法连接 MySQL 测试库（tester@127.0.0.1:3306/campus_activity_test）：${reason}\n`)
        .environmentBlockedReason,
    ).toBe(MYSQL_ENVIRONMENT_BLOCKED_REASON);
    expect(collect(`AssertionError: ${reason}`).environmentBlockedReason).toBeUndefined();
  });
  it("retains all three actual Node assertions around >60KB noise while keeping raw output at 16KB", async () => {
    const root =
      await fixture(`const {test} = require('node:test'); const assert = require('node:assert/strict');
for (let i=0;i<3;i++) test('contract-'+i, () => { console.log('noise-'+i+' '+ 'x'.repeat(24000)); assert.equal(i, 9, 'middle-assertion-'+i); });
test('tail-noise', () => console.log('tail '+'y'.repeat(24000)));`);
    const result = await executeAcceptanceCommand(command, path.join(root, "backend"));
    expect(result.exitCode).toBe(1);
    expect(result.output.length).toBeLessThanOrEqual(ACCEPTANCE_OUTPUT_LIMIT);
    expect(result.output).toContain("[输出已截断]");
    for (let i = 0; i < 3; i++) expect(result.failureEvidence).toContain(`middle-assertion-${i}`);
    expect(result.failureEvidenceIncomplete).toBeUndefined();
    const report = await runProjectAcceptance(root, {
      onlyCheckIds: ["backend-test"],
      executor: async () => result,
    });
    expect(report.checks[0].failureEvidence).toBe(result.failureEvidence);
    expect(report.status).toBe("failed");
  });
  it("reports a captured middle MySQL connection failure as blocked despite Node failure counts", async () => {
    const root = await fixture(
      `const {test} = require('node:test'); test('db', () => { console.log('x'.repeat(30000)); console.error('集成测试无法连接 MySQL: ENOTFOUND db'); console.log('y'.repeat(30000)); throw new Error('database setup missing'); });`,
    );
    const result = await executeAcceptanceCommand(command, path.join(root, "backend"));
    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain("集成测试无法连接 MySQL");
    expect(result.environmentBlockedReason).toBe(MYSQL_ENVIRONMENT_BLOCKED_REASON);
    const report = await runProjectAcceptance(root, {
      onlyCheckIds: ["backend-test"],
      executor: async () => result,
    });
    expect(report.status).toBe("blocked");
    expect(report.checks[0].output).toContain("真实 MySQL 集成测试环境不可用");
  });
});
