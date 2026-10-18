import { describe, it, expect } from "vitest";
import {
  selectRepairCheck,
  assertFocusedRepairPlan,
  focusedRepairPrompt,
  assertRepairChanges,
} from "@/lib/repair-strategy";
import type { AcceptanceReport } from "@/lib/acceptance";
const report = (checks: AcceptanceReport["checks"]) =>
  ({
    version: 1,
    status: "failed",
    checks,
    limitations: [],
    startedAt: "",
    finishedAt: "",
  }) as AcceptanceReport;
const check = (id: string, status: "passed" | "failed", output = "") => ({
  id,
  label: id,
  command: "fixed",
  status,
  output,
  durationMs: 1,
});
describe("focused repair strategy", () => {
  it("blocks new test bypasses and reduced assertions before changeset creation", () => {
    const change = {
      action: "modify" as const,
      path: "client/tests/auth.test.js",
      content: "it.skip('auth',()=>expect(true).toBe(true))",
    };
    expect(() =>
      assertRepairChanges([change], () => "it('auth',()=>expect(true).toBe(true))"),
    ).toThrow("跳过");
    expect(() =>
      assertRepairChanges(
        [{ ...change, content: "it('auth',()=>{})" }],
        () => "expect(user).toBeDefined()",
      ),
    ).toThrow("断言");
  });
  it("preserves declared build/test scripts while allowing missing dependency additions", () => {
    const original = JSON.stringify({ scripts: { test: "vitest run" } });
    expect(() =>
      assertRepairChanges(
        [
          {
            action: "modify",
            path: "client/package.json",
            content: JSON.stringify({ scripts: { test: "echo passed" } }),
          },
        ],
        () => original,
      ),
    ).toThrow("验收脚本");
    expect(() =>
      assertRepairChanges(
        [
          {
            action: "modify",
            path: "client/package.json",
            content: JSON.stringify({
              scripts: { test: "vitest run" },
              devDependencies: { "@vitejs/plugin-vue": "^6" },
            }),
          },
        ],
        () => original,
      ),
    ).not.toThrow();
  });
  it("prioritizes broken build before business test failures", () => {
    expect(
      selectRepairCheck(
        report([
          check("backend-test", "failed", "✖ incorrect roles"),
          check("frontend-build", "failed", "Cannot find module plugin"),
        ]),
      ),
    ).toBe("frontend-build");
  });
  it("prioritizes previously passing regressions", () => {
    const previous = report([check("frontend-build", "failed"), check("backend-test", "passed")]);
    expect(
      selectRepairCheck(
        report([check("frontend-build", "failed"), check("backend-test", "failed")]),
        previous,
      ),
    ).toBe("backend-test");
  });
  it("rejects deleting tests or escaping failing subsystem without numerical quotas", () => {
    const file = {
      action: "modify" as const,
      path: "client/src/router/index.js",
      reason: "Fix failed role mapping",
    };
    expect(() => assertFocusedRepairPlan({ steps: [file] }, "frontend-test", [])).not.toThrow();
    expect(() =>
      assertFocusedRepairPlan(
        { steps: [{ ...file, path: "backend/package.json" }] },
        "frontend-test",
        [],
      ),
    ).toThrow("范围");
    expect(() =>
      assertFocusedRepairPlan({ steps: [{ ...file, action: "delete" }] }, "frontend-test", []),
    ).toThrow("删除");
  });
  it("keeps successful checks and prohibits lowering acceptance bar in prompt", () => {
    const text = focusedRepairPrompt(
      report([
        check("frontend-build", "passed"),
        check("frontend-test", "failed", " FAIL  tests/router.test.js > role guard"),
      ]),
      "frontend-test",
    );
    expect(text).toContain("frontend-build");
    expect(text).toContain("role guard");
    expect(text).toContain("不得删测试");
    expect(text).toContain("定向通过不代表可交付");
  });
});
