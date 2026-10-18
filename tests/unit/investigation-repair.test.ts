import { describe, it, expect } from "vitest";
import { repairEvidenceFromInvestigation } from "@/lib/investigation-repair";
import type { AcceptanceReport } from "@/lib/acceptance";
const report: AcceptanceReport = {
  version: 1,
  status: "blocked",
  limitations: [],
  checks: [
    {
      id: "backend-test",
      label: "test",
      status: "blocked",
      command: "node --test",
      output: "命令超过 120000ms 执行时限。",
      durationMs: 120000,
    },
  ],
};
const investigation = {
  disposition: "repair",
  observations: [
    {
      request: { tool: "node_test", directory: "backend" },
      result: {
        exitCode: 1,
        output:
          "✖ exports app\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n  actual: false\n  expected: true\n  operator: strictEqual",
        truncated: false,
      },
    },
  ],
};
describe("grounded repair after full-suite timeout", () => {
  it("permits scoped repair after complete real reproduction without changing actual report", () => {
    const r = repairEvidenceFromInvestigation(report, "backend-test", investigation);
    expect(r?.status).toBe("failed");
    expect(report.status).toBe("blocked");
    expect(report.checks[0].output).toContain("120000");
  });
  it.each(["environment", "insufficient"])("refuses %s conclusions", (disposition) =>
    expect(
      repairEvidenceFromInvestigation(report, "backend-test", { ...investigation, disposition }),
    ).toBeNull(),
  );
  it("refuses truncated/permission-only evidence", () => {
    expect(
      repairEvidenceFromInvestigation(report, "backend-test", {
        ...investigation,
        observations: [
          {
            request: { tool: "node_test", directory: "backend" },
            result: { exitCode: 1, output: "permission denied", blockedReason: "denied" },
          },
        ],
      }),
    ).toBeNull();
  });
  it("does not reinterpret MySQL or missing tool blockers", () => {
    expect(
      repairEvidenceFromInvestigation(
        { ...report, checks: [{ ...report.checks[0], output: "真实 MySQL 集成测试环境不可用" }] },
        "backend-test",
        investigation,
      ),
    ).toBeNull();
  });
  it("refuses independent environmental blockers", () => {
    expect(
      repairEvidenceFromInvestigation(
        {
          ...report,
          checks: [
            ...report.checks,
            {
              id: "frontend-build",
              label: "build",
              status: "blocked",
              output: "Required tool unavailable",
              durationMs: 0,
            },
          ],
        },
        "backend-test",
        investigation,
      ),
    ).toBeNull();
  });
});
