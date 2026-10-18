import { describe, expect, it } from "vitest";
import type { AcceptanceCheck, AcceptanceReport } from "@/lib/acceptance";
import {
  buildRepairDiagnostics,
  compareRepairDiagnostics,
  hasCompleteRepairDiagnostics,
} from "@/lib/repair-diagnostics";

function check(output: string, overrides: Partial<AcceptanceCheck> = {}): AcceptanceCheck {
  return {
    id: "backend-test",
    label: "后端测试",
    status: "failed",
    command: "node --test",
    output,
    durationMs: 8,
    ...overrides,
  };
}
function diagnostics(...checks: AcceptanceCheck[]) {
  const report: AcceptanceReport = { version: 1, status: "failed", checks, limitations: [] };
  return buildRepairDiagnostics(report);
}
const nodeFailure = (root = "/tmp/run-one/.workspace/project-one", timing = "7.45") => `
✔ handles expected database failure (2.17ms)
Error: 数据库耗尽
    at ${root}/backend/src/database.js:5:8
✖ returns fallback recommendations (${timing}ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  expected: 200
  actual: 500
  at TestContext.<anonymous> (${root}/backend/tests/recommendations.test.js:42:9)
✔ rejects missing token (1.88ms)
ℹ tests 3
ℹ pass 2
ℹ fail 1
`;

describe("structured repair diagnostics", () => {
  it("uses separately captured complete assertions despite truncated console output", () => {
    const result = diagnostics(
      check("noise [输出已截断]", {
        failureEvidence: nodeFailure(),
        failureEvidenceIncomplete: false,
      }),
    );
    expect(hasCompleteRepairDiagnostics(result, "backend-test")).toBe(true);
    expect(result.issues[0].title).toContain("returns fallback");
    const clipped = diagnostics(
      check("noise", { failureEvidence: nodeFailure(), failureEvidenceIncomplete: true }),
    );
    expect(hasCompleteRepairDiagnostics(clipped, "backend-test")).toBe(false);
  });
  it("extracts actual named Node failures without promoting expected native error logs", () => {
    const result = diagnostics(check(nodeFailure()));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      title: "returns fallback recommendations",
      category: "test",
      paths: ["backend/tests/recommendations.test.js"],
    });
    expect(result.issues[0].evidence).toContain("expected: 200");
    expect(result.issues[0].evidence).not.toContain("数据库耗尽");
    expect(result.issues[0].evidence).not.toContain("pass 2");
    expect(result.incompleteCheckIds).toEqual([]);
  });

  it("ignores timings, warning noise, temporary roots and report metadata in fingerprints", () => {
    const previous = diagnostics(check(nodeFailure()));
    const current = diagnostics(
      check(
        nodeFailure("C:\\Temp\\random\\.workspace\\another-id", "197.882")
          .replaceAll("/backend/", "\\backend\\")
          .replace("ℹ tests 3", "warning: 400 cache misses\nℹ tests 50"),
        { durationMs: 9999, label: "后端测试 changed" },
      ),
    );
    expect(current.signature).toBe(previous.signature);
    expect(compareRepairDiagnostics(previous, current).stalled).toBe(true);
  });

  it("prefers detailed Vitest FAIL names to duplicate × summary failures", () => {
    const result = diagnostics(
      check(
        `
 ❯ tests/feed.test.ts (3 tests | 2 failed) 118ms
   × feed > loads recommendations 12ms
   × feed > ranks candidates 9ms
stderr | tests/feed.test.ts > deliberately fails database
Error: 数据库耗尽
 FAIL  tests/feed.test.ts > feed > loads recommendations
AssertionError: expected [] to have a length of 2
 ❯ tests/feed.test.ts:10:4
 FAIL  tests/feed.test.ts > feed > ranks candidates
AssertionError: expected 'a' to be 'b'
 ❯ tests/feed.test.ts:22:4
 Tests 2 failed | 1 passed (3)
`,
        { command: "vitest run" },
      ),
    );
    expect(result.issues).toHaveLength(2);
    expect(result.issues.map((issue) => issue.title).sort()).toEqual([
      "backend/tests/feed.test.ts > feed > loads recommendations",
      "backend/tests/feed.test.ts > feed > ranks candidates",
    ]);
    expect(result.issues.every((issue) => issue.category === "test")).toBe(true);
    expect(result.issues.every((issue) => issue.paths.includes("backend/tests/feed.test.ts"))).toBe(
      true,
    );
    expect(result.issues.every((issue) => issue.evidence.includes("AssertionError"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("数据库耗尽");
  });

  it("extracts Vitest × test names underneath their file group when FAIL lines are absent", () => {
    const result = diagnostics(
      check(
        " ❯ src/feed.test.ts (2 tests | 1 failed) 19ms\n   × feed > loads recommendations 8ms\n   ✓ feed > rejects bad token 2ms",
        { id: "frontend-test", command: "vitest run" },
      ),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].title).toBe("client/src/feed.test.ts > feed > loads recommendations");
  });

  it("groups root build errors and missing dependencies without generic warnings", () => {
    const result = diagnostics(
      check(
        `warning: Error: stale cache\nbuilding...\nerror during build:\nCould not resolve "./missing" from "src/App.tsx"\n120 modules transformed in 31ms`,
        { id: "frontend-build", label: "前端构建", command: "vite build" },
      ),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("dependency");
    expect(result.issues[0].paths).toEqual(["client/src/App.tsx"]);
    expect(result.issues[0].evidence).not.toContain("stale cache");
    expect(result.issues[0].evidence).not.toContain("modules transformed");
  });

  it("handles tsc, syntax and environment roots", () => {
    expect(
      diagnostics(
        check(
          "src/index.ts(2,8): error TS2322: Type 'string' is not assignable to type 'number'.",
          { id: "backend-build", command: "tsc" },
        ),
      ).issues[0].category,
    ).toBe("build");
    expect(
      diagnostics(
        check("/tmp/run/backend/src/index.js:9\nSyntaxError: Unexpected token '}'", {
          id: "backend-syntax",
          command: "node --check",
        }),
      ).issues[0].category,
    ).toBe("build");
    expect(
      diagnostics(
        check("Required tool mvn is unavailable.", { id: "backend-verify", status: "blocked" }),
      ).issues[0].category,
    ).toBe("environment");
  });

  it("retains explicit metadata planning blockers and excludes passed/skipped checks", () => {
    const result = diagnostics(
      check("构建脚本缺失或无法识别。", {
        id: "frontend-build",
        command: undefined,
        status: "blocked",
      }),
      check("后续将接入真实 API", {
        id: "implementation-placeholders",
        command: undefined,
        status: "blocked",
      }),
      check("✖ not a failure", { id: "passed-check", status: "passed" }),
      check("✖ not a failure", { id: "skipped-check", status: "skipped" }),
    );
    expect(result.issues).toHaveLength(2);
    expect(result.issues.find((issue) => issue.checkId === "frontend-build")?.evidence).toContain(
      "构建脚本缺失",
    );
  });

  it("does not fabricate missing named failures from a prefix-truncated report", () => {
    const result = diagnostics(
      check("✔ expected DB failure\nError: 数据库耗尽\n# tests 80\n[输出已截断]"),
    );
    expect(result.issues).toEqual([]);
    expect(result.incompleteReasons["backend-test"]).toContain("no named failure");
    expect(result.incompleteReasons["backend-test"]).toContain("Output truncated");
    expect(hasCompleteRepairDiagnostics(result)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("数据库耗尽");
    expect(compareRepairDiagnostics(result, result).stalled).toBe(false);
  });

  it("marks untruncated failure-count-only evidence incomplete instead of stable proof", () => {
    const result = diagnostics(check("Tests 2 failed | 100 passed (102)"));
    expect(result.incompleteCheckIds).toEqual(["backend-test"]);
    expect(compareRepairDiagnostics(result, result).stalled).toBe(false);
  });

  it("notes missing evidence even when named failures survived truncation", () => {
    const result = diagnostics(check(`${nodeFailure()}\n[输出已截断]`));
    expect(result.issues[0].title).toBe("returns fallback recommendations");
    expect(result.issues[0].evidence).toContain("important failure evidence may be missing");
    expect(compareRepairDiagnostics(result, result).stalled).toBe(false);
  });

  it("detects resolved, new, persistent and passed-to-blocked/failed regressions", () => {
    const before = diagnostics(
      check("✖ first (3ms)\n✖ second (2ms)"),
      check("all good", { id: "frontend-build", status: "passed" }),
    );
    const after = diagnostics(
      check("✖ second (8ms)"),
      check("Required tool npm is unavailable.", { id: "frontend-build", status: "blocked" }),
    );
    const comparison = compareRepairDiagnostics(before, after);
    expect(comparison.resolvedIds).toHaveLength(1);
    expect(comparison.persistentIds).toHaveLength(1);
    expect(comparison.newIds).toHaveLength(1);
    expect(comparison.regressedCheckIds).toEqual(["frontend-build"]);
    expect(comparison.stalled).toBe(false);
  });

  it("does not call a reduction stalled while retaining the remaining failure identity", () => {
    const previous = diagnostics(
      check(
        "✖ first (3ms)\nAssertionError: first\n✖ second (2ms)\nAssertionError: expected 2 to equal 3",
      ),
    );
    const current = diagnostics(check("✖ second (10ms)\nAssertionError: expected 2 to equal 3"));
    const comparison = compareRepairDiagnostics(previous, current);
    expect(comparison.resolvedIds).toHaveLength(1);
    expect(comparison.persistentIds).toHaveLength(1);
    expect(comparison.stalled).toBe(false);
    expect(
      compareRepairDiagnostics(
        current,
        diagnostics(check("✖ second (88ms)\nAssertionError: expected 2 to equal 3")),
      ).stalled,
    ).toBe(true);
  });

  it("does not conflate changed assertion semantics or changed failure names", () => {
    const before = diagnostics(check(nodeFailure()));
    const after = diagnostics(check(nodeFailure().replace("actual: 500", "actual: 503")));
    expect(after.signature).not.toBe(before.signature);
    expect(compareRepairDiagnostics(before, after).persistentIds).toEqual([]);
  });

  it("rejects traversal and external paths and keeps Windows project paths safe", () => {
    const result = diagnostics(
      check(
        "✖ broken (8ms)\n at C:\\Temp\\.workspace\\random\\backend\\tests\\feed.test.js:4:7\n at /etc/secrets.ts:1:2\n at ../outside.test.js:2:3",
      ),
    );
    expect(result.issues[0].paths).toEqual(["backend/tests/feed.test.js"]);
    expect(result.issues[0].evidence).not.toContain("C:/Temp");
    expect(result.issues[0].evidence).not.toContain("/etc/secrets");
  });

  it("deduplicates repeated Node failing-tests sections and makes issue order irrelevant", () => {
    const result = diagnostics(
      check("✖ first (1ms)\n✖ second (2ms)\n✖ failing tests:\n✖ first (8ms)\n✖ second (9ms)"),
    );
    expect(result.issues).toHaveLength(2);
    expect(result.signature).toBe(diagnostics(check("✖ second (7ms)\n✖ first (6ms)")).signature);
  });

  it("merges repeated Node failure sections that only repeat the name before adding assertions", () => {
    const result = diagnostics(
      check(
        "✖ broken (1ms)\nℹ fail 1\n✖ failing tests:\ntest at /tmp/run/backend/tests/feed.test.js:5:1\n✖ broken (9ms)\n AssertionError: expected 2 to equal 3\n expected: 3\n actual: 2",
      ),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].paths).toEqual(["backend/tests/feed.test.js"]);
    expect(result.issues[0].evidence).toContain("AssertionError");
  });

  it("parses persisted Vitest shared suite startup failures despite all individual tests passing", () => {
    const suites = ["activity-list-query", "build-config", "guard-runtime", "request-interceptor"];
    const output = `Vitest 摘要包含失败测试；即使命令退出码为零也不能通过。
 RUN v5.0.3 D:/D77/money_project/BYSJ/graduateStudio/.workspace/project/client
warning: Module "node:fs" has been externalized for browser compatibility
${suites.map((name) => ` ❯ tests/${name}.test.js (0 test)`).join("\n")}
⎯⎯ Failed Suites 4 ⎯⎯
${suites.map((name) => ` FAIL  tests/${name}.test.js [ tests/${name}.test.js ]`).join("\n")}
Error: No such built-in module: node:
 Test Files 4 failed | 13 passed (17)
 Tests 160 passed (160)`;
    const result = diagnostics(check(output, { id: "frontend-test" }));
    expect(result.issues).toHaveLength(4);
    expect(result.issues.every((issue) => issue.category === "test")).toBe(true);
    expect(
      result.issues.every((issue) =>
        issue.evidence.includes("Error: No such built-in module: node:"),
      ),
    ).toBe(true);
    expect(result.issues.flatMap((issue) => issue.paths).sort()).toEqual(
      suites.map((name) => `client/tests/${name}.test.js`).sort(),
    );
    expect(result.incompleteCheckIds).toEqual([]);
    expect(hasCompleteRepairDiagnostics(result, "frontend-test")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("failure details unavailable");
  });

  it("recognizes explicit startup errors without treating expected error console logs as causes", () => {
    const result = diagnostics(
      check(
        `⎯⎯ Startup Error ⎯⎯\nError: Invariant violation: new TextEncoder().encode(\"\") instanceof Uint8Array is incorrectly false`,
        { id: "frontend-test" },
      ),
    );
    expect(result.issues[0].evidence).toContain("Invariant violation");
    expect(hasCompleteRepairDiagnostics(result, "frontend-test")).toBe(true);
    const passedOnly = diagnostics(
      check("Tests 174 passed (174)\nError: deliberate expected error"),
    );
    expect(passedOnly.issues).toEqual([]);
    expect(hasCompleteRepairDiagnostics(passedOnly)).toBe(false);
  });

  it("requires assertions or startup causes even if failure names or stack paths are available", () => {
    for (const output of [
      "✖ broken (1ms)",
      "✖ broken (1ms)\n at tests/feed.test.js:4:5",
      "Tests 2 failed | 100 passed (102)",
      "Tests 100 passed (100)\n（输出已截取）",
    ]) {
      const result = diagnostics(check(output));
      expect(hasCompleteRepairDiagnostics(result, "backend-test")).toBe(false);
      expect(compareRepairDiagnostics(result, result).stalled).toBe(false);
      expect(result.incompleteReasons["backend-test"]).toBeTruthy();
    }
  });

  it("never calls an empty successful issue set stalled", () => {
    const passed = diagnostics(check("✓ good", { status: "passed" }));
    expect(compareRepairDiagnostics(passed, passed).stalled).toBe(false);
  });
});
