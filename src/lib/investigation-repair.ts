import type { AcceptanceReport } from "./acceptance";
import { canRepairFullProjectAcceptance } from "./full-project";
import { buildRepairDiagnostics, hasCompleteRepairDiagnostics } from "./repair-diagnostics";

/** A timed-out full run is NOT passed. A bounded reproduction can authorize a scoped repair. */
export function repairEvidenceFromInvestigation(
  report: AcceptanceReport,
  focusId: string,
  investigation: {
    disposition: string;
    observations: Array<{ request: { tool: string; directory?: string }; result: unknown }>;
  },
): AcceptanceReport | null {
  if (investigation.disposition !== "repair") return null;
  if (
    canRepairFullProjectAcceptance(report) &&
    hasCompleteRepairDiagnostics(buildRepairDiagnostics(report), focusId)
  )
    return report;
  const focus = report.checks.find((c) => c.id === focusId);
  if (
    !focus ||
    focus.status !== "blocked" ||
    !/^命令超过 \d+ms 执行时限。/.test(focus.output) ||
    focusId !== "backend-test"
  )
    return null;
  if (report.checks.some((c) => c.id !== focusId && c.status === "blocked")) return null;
  const outputs = investigation.observations.flatMap((o) => {
    const r = o.result as {
      exitCode?: number;
      output?: string;
      truncated?: boolean;
      blockedReason?: string;
    };
    return o.request.tool === "node_test" &&
      o.request.directory === "backend" &&
      r.exitCode === 1 &&
      !r.truncated &&
      !r.blockedReason &&
      typeof r.output === "string"
      ? [r.output]
      : [];
  });
  if (!outputs.length) return null;
  const evidence: AcceptanceReport = {
    ...report,
    status: "failed",
    checks: report.checks.map((c) =>
      c.id === focusId
        ? {
            ...c,
            status: "failed",
            output: outputs.join("\n"),
            failureEvidence: outputs.join("\n"),
            failureEvidenceIncomplete: false,
          }
        : c,
    ),
  };
  return canRepairFullProjectAcceptance(evidence) &&
    hasCompleteRepairDiagnostics(buildRepairDiagnostics(evidence), focusId)
    ? evidence
    : null;
}
