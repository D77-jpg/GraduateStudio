"use client";

import { z } from "zod";
import type { AgentTaskDto } from "@/lib/agent";
import {
  summarizeAcceptance,
  type AcceptanceReport as AcceptanceReportData,
  type AcceptanceCheckStatus,
} from "@/lib/acceptance";
import { Badge } from "@/components/ui/badge";

export const ACCEPTANCE_REPORT_MARKER = "ACCEPTANCE_REPORT\n";

// Validate persisted JSON at the UI boundary; a task's completed flag is not evidence.
const reportSchema: z.ZodType<AcceptanceReportData> = z
  .object({
    version: z.literal(1),
    status: z.enum(["passed", "failed", "blocked"]),
    checks: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        status: z.enum(["passed", "failed", "blocked", "skipped"]),
        command: z.string().optional(),
        output: z.string(),
        durationMs: z.number().finite().nonnegative().optional(),
        failureEvidence: z.string().optional(),
        failureEvidenceIncomplete: z.boolean().optional(),
      }),
    ),
    limitations: z.array(z.string()),
  })
  .refine((report) => report.status === summarizeAcceptance(report.checks), {
    message: "Report status does not agree with its checks",
  });

type ReportResult =
  { kind: "missing" } | { kind: "invalid" } | { kind: "report"; report: AcceptanceReportData };

export function readTaskAcceptanceReport(steps: AgentTaskDto["steps"]): ReportResult {
  // Prefer the latest attempt, including an invalid latest report; never fall back
  // to an older passing attempt when newer evidence cannot be validated.
  const latest = [...steps]
    .sort((a, b) => b.index - a.index)
    .find((step) => step.detail.trimStart().startsWith(ACCEPTANCE_REPORT_MARKER));
  if (!latest) return { kind: "missing" };
  try {
    const json: unknown = JSON.parse(
      latest.detail.trimStart().slice(ACCEPTANCE_REPORT_MARKER.length),
    );
    const parsed = reportSchema.safeParse(json);
    return parsed.success ? { kind: "report", report: parsed.data } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

const CHECK_LABELS: Record<AcceptanceCheckStatus, string> = {
  passed: "通过",
  failed: "未通过",
  blocked: "受阻",
  skipped: "已跳过（非通过）",
};
const CHECK_TONES = {
  passed: "success",
  failed: "danger",
  blocked: "neutral",
  skipped: "neutral",
} as const;

export function AcceptanceReport({ task }: { task: AgentTaskDto }) {
  const result = readTaskAcceptanceReport(task.steps);
  if (result.kind === "missing") {
    const pending = [
      "queued",
      "analyzing",
      "planning",
      "coding",
      "checking",
      "fixing",
      "paused",
    ].includes(task.status);
    return (
      <section
        aria-label="工程验收报告"
        className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-500/10 dark:text-amber-300"
      >
        {pending
          ? "尚未生成新版工程验收报告，当前执行状态不代表验收通过或业务可交付。"
          : "未执行新版工程验收，历史完成状态不代表可交付"}
      </section>
    );
  }
  if (result.kind === "invalid") {
    return (
      <section
        aria-label="工程验收报告"
        className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-500/10 dark:text-amber-300"
      >
        <p className="font-semibold">验收受阻</p>
        <p className="mt-1">
          验收报告格式无效、版本不受支持或结果与检查项不一致，无法确认工程检查通过。请查看开发过程中的原始记录。
        </p>
      </section>
    );
  }

  const { report } = result;
  const blockedChecks = report.checks.filter((check) => check.status === "blocked");
  // Use the persisted acceptance classification, not a guessed diagnosis from failed counts.
  const mysqlEnvironmentBlocked = blockedChecks.some(
    (check) =>
      check.id === "backend-test" && check.output.startsWith("真实 MySQL 集成测试环境不可用"),
  );
  const statusLabel =
    report.status === "passed"
      ? "工程检查通过"
      : report.status === "failed"
        ? "验收未通过"
        : "验收受阻";
  return (
    <section
      aria-label="工程验收报告"
      className="mt-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-700"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">工程验收报告</h3>
        <Badge tone={CHECK_TONES[report.status]}>{statusLabel}</Badge>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
        本报告仅说明本次任务的有限工程检查结果，不代表业务功能完整、端到端验证通过或项目可交付；真实接口、数据库与用户流程仍需单独验收。
      </p>
      {blockedChecks.length ? (
        <div
          aria-label="验收阻塞原因与下一步"
          className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-500/10 dark:text-amber-300"
        >
          <h4 className="font-semibold">先处理验收阻塞，再继续</h4>
          <ul className="mt-2 space-y-1">
            {blockedChecks.map((check, index) => (
              <li key={`${check.id}-${index}`} className="whitespace-pre-wrap break-words">
                {check.label}：
                {check.output.split(/\r?\n/).find((line) => line.trim()) ||
                  "未保存阻塞原因，请查看原始检查记录。"}
              </li>
            ))}
          </ul>
          {mysqlEnvironmentBlocked ? (
            <>
              <p className="mt-2">
                请在实际执行验收的环境中配置并启动真实 MySQL
                测试库，核对项目测试配置的主机名、端口、账号权限与测试数据库，并按项目说明准备测试数据；不要使用生产数据库。
              </p>
              <p className="mt-1">
                测试摘要中的失败数量不能单独证明有同等数量的代码缺陷；当前已记录数据库环境阻塞，修复环境后仍须重新验收，其他失败也需核对。
              </p>
            </>
          ) : (
            <p className="mt-2">
              请根据以上具体原因补齐工具、依赖、测试或外部环境，并查看下方检查输出与失败证据。
            </p>
          )}
          <p className="mt-2">
            环境或配置未改变时反复继续可能得到相同结果。处理后再手动继续，将重新执行验收；不会跳过测试或自动视为通过。
          </p>
        </div>
      ) : null}
      <ul className="mt-3 space-y-2">
        {report.checks.map((check, index) => (
          <li
            key={`${check.id}-${index}`}
            className="rounded-md bg-zinc-50 p-2.5 dark:bg-zinc-800/60"
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-zinc-800 dark:text-zinc-200">{check.label}</span>
              <Badge tone={CHECK_TONES[check.status]}>{CHECK_LABELS[check.status]}</Badge>
              <span className="text-zinc-500">
                {check.durationMs === undefined
                  ? "耗时未知（未记录）"
                  : `耗时 ${check.durationMs.toLocaleString("zh-CN")} ms`}
              </span>
            </div>
            <p className="mt-2 break-all text-[11px] text-zinc-500 dark:text-zinc-400">
              命令：{check.command?.trim() ? <code>{check.command}</code> : "未知（未记录）"}
            </p>
            <details className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
              <summary className="cursor-pointer">查看检查输出</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-white p-2 font-mono text-[11px] dark:bg-zinc-900">
                {check.output || "未保存输出"}
              </pre>
            </details>
            {check.failureEvidenceIncomplete ? (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                失败证据收集不完整，不能据此声称已定位全部失败；请核对完整测试日志。
              </p>
            ) : null}
            {check.failureEvidence || check.failureEvidenceIncomplete ? (
              <details className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                <summary className="cursor-pointer">查看具体失败证据（独立于检查输出）</summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-white p-2 font-mono text-[11px] dark:bg-zinc-900">
                  {check.failureEvidence || "未保存具体失败证据"}
                </pre>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      <h4 className="mt-3 text-xs font-semibold text-zinc-800 dark:text-zinc-200">验收限制</h4>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        {report.limitations.length ? (
          report.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)
        ) : (
          <li>报告未提供额外限制说明；这不意味着业务交付已得到验证。</li>
        )}
      </ul>
    </section>
  );
}
