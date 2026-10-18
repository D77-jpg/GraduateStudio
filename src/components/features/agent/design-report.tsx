"use client";

import { z } from "zod";
import type { AgentTaskDto } from "@/lib/agent";
import { Badge } from "@/components/ui/badge";

export const DESIGN_REPORT_MARKER = "DESIGN_REPORT\n";

const nonblank = z.string().refine((value) => value.trim().length > 0);
// Unknown metadata is intentionally stripped, never rendered or treated as instructions.
// Keep this UI boundary independent of server-side design generation and filesystem code.
const reportSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["specified", "missing", "invalid", "not_required"]),
    artifacts: z.array(z.object({ path: nonblank, sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) })),
    issues: z.array(z.string()),
    visual: z.object({ status: z.literal("not_run"), reason: nonblank }),
    skills: z.array(z.object({ id: nonblank, revision: nonblank })).optional(),
  })
  .refine((report) => report.status !== "specified" || report.artifacts.length > 0);

export type DesignReportData = z.infer<typeof reportSchema>;
type ReportResult =
  { kind: "missing" } | { kind: "invalid" } | { kind: "report"; report: DesignReportData };

export function readTaskDesignReport(steps: AgentTaskDto["steps"]): ReportResult {
  let latest: AgentTaskDto["steps"][number] | undefined;
  for (const step of steps) {
    if (
      typeof step.detail !== "string" ||
      !/^DESIGN_REPORT(?:\r?\n|$)/.test(step.detail.trimStart())
    )
      continue;
    // An unordered report cannot safely be classified as older evidence.
    if (!Number.isSafeInteger(step.index)) return { kind: "invalid" };
    if (!latest || step.index >= latest.index) latest = step;
  }
  if (!latest) return { kind: "missing" };
  try {
    const detail = latest.detail.trimStart();
    if (!detail.startsWith(DESIGN_REPORT_MARKER)) return { kind: "invalid" };
    const json: unknown = JSON.parse(detail.slice(DESIGN_REPORT_MARKER.length));
    const parsed = reportSchema.safeParse(json);
    return parsed.success ? { kind: "report", report: parsed.data } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

const STATUS_LABELS: Record<DesignReportData["status"], string> = {
  specified: "设计规范已生成",
  missing: "设计规范缺失",
  invalid: "设计规范无效",
  not_required: "本次任务无需设计规范",
};

export function DesignReport({ task }: { task: AgentTaskDto }) {
  const result = readTaskDesignReport(task.steps);
  if (result.kind === "missing") return null;
  if (result.kind === "invalid") {
    return (
      <section
        aria-label="UI 设计证据"
        className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-500/10 dark:text-amber-300"
      >
        <h3 className="text-sm font-semibold">设计规范无效</h3>
        <p className="mt-1">
          设计证据无效：最新报告格式错误、版本不受支持或字段不完整，不能确认设计规范已生成。
        </p>
        <p className="mt-1">视觉验收未执行；本报告不能证明界面美观或视觉质量通过。</p>
      </section>
    );
  }

  const { report } = result;
  return (
    <section
      aria-label="UI 设计证据"
      className="mt-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-700"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">UI 设计证据</h3>
        <Badge
          tone={report.status === "missing" || report.status === "invalid" ? "danger" : "neutral"}
        >
          {STATUS_LABELS[report.status]}
        </Badge>
        <Badge tone="neutral">视觉验收未执行</Badge>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
        本报告仅记录设计规范文件证据，不代表界面美观、视觉质量通过或业务可交付；文件摘要为报告记录，未在浏览器重新校验。
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-500 dark:text-zinc-400">
        未执行原因：{report.visual.reason}
      </p>
      {report.artifacts.length ? (
        <ul aria-label="设计规范文件证据" className="mt-3 space-y-2 text-xs">
          {report.artifacts.map((artifact, index) => (
            <li key={index} className="rounded-md bg-zinc-50 p-2.5 dark:bg-zinc-800/60">
              <p className="break-all text-zinc-800 dark:text-zinc-200">
                文件：<code>{artifact.path}</code>
              </p>
              <p
                className="mt-1 break-all text-zinc-500 dark:text-zinc-400"
                title={artifact.sha256}
              >
                SHA-256 摘要：
                <code>
                  {artifact.sha256.slice(0, 12)}…{artifact.sha256.slice(-8)}
                </code>
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {report.skills?.length ? (
        <div className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
          <h4 className="font-semibold">技能资源版本（不代表已实际使用）</h4>
          <ul className="mt-1 space-y-1">
            {report.skills.map((skill, index) => (
              <li key={index} className="break-all">
                <code>{skill.id}</code> · 资源版本：<code>{skill.revision}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.issues.length ? (
        <ul
          aria-label="设计规范问题"
          className="mt-3 list-disc space-y-1 pl-4 text-xs text-amber-700 dark:text-amber-400"
        >
          {report.issues.map((issue, index) => (
            <li key={index} className="whitespace-pre-wrap break-words">
              {issue}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
