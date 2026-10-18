"use client";

import { z } from "zod";
import type { AgentTaskDto } from "@/lib/agent";
import { Badge } from "@/components/ui/badge";

export const RUNTIME_REPAIR_REPORT_MARKER = "RUNTIME_REPAIR_REPORT\n";

const boundedText = z.string().max(2048);
// This is a local display boundary, not a server/API contract. Unknown metadata
// (including raw endpoint addresses and credentials) is deliberately stripped.
const reportSchema = z.object({
  version: z.literal(1),
  status: z.enum(["collected", "blocked"]),
  taskId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  taskState: boundedText.nullish(),
  failureCode: boundedText.nullish(),
  connectivity: z
    .enum(["connected", "refused", "timeout", "dns_error", "blocked", "not_configured"])
    .nullish(),
  endpoint: z
    .object({
      hostKind: z.enum(["loopback", "private", "public", "local_name", "unknown"]).nullable(),
      port: z.number().int().min(1).max(65535).nullable(),
    })
    .nullish(),
  modelCalls: z.literal(0),
  issues: z.array(boundedText).max(50),
  needsUserAction: z.boolean(),
});

export type RuntimeRepairReportData = z.infer<typeof reportSchema>;
type ReportResult =
  { kind: "missing" } | { kind: "invalid" } | { kind: "report"; report: RuntimeRepairReportData };

export function readTaskRuntimeRepairReport(
  steps: AgentTaskDto["steps"] | null | undefined,
): ReportResult {
  let latest: AgentTaskDto["steps"][number] | undefined;
  for (const step of steps ?? []) {
    if (
      typeof step.detail !== "string" ||
      !/^RUNTIME_REPAIR_REPORT(?:\r?\n|$)/.test(step.detail.trimStart())
    )
      continue;
    if (!Number.isSafeInteger(step.index)) return { kind: "invalid" };
    if (!latest || step.index >= latest.index) latest = step;
  }
  if (!latest) return { kind: "missing" };
  const detail = latest.detail.trimStart();
  // Bound persisted input before JSON parsing; never fall back to older evidence.
  if (!detail.startsWith(RUNTIME_REPAIR_REPORT_MARKER) || detail.length > 128_000)
    return { kind: "invalid" };
  try {
    const json: unknown = JSON.parse(detail.slice(RUNTIME_REPAIR_REPORT_MARKER.length));
    const result = reportSchema.safeParse(json);
    return result.success ? { kind: "report", report: result.data } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

const CONNECTIVITY_LABELS = {
  connected: "已连接",
  refused: "连接被拒绝",
  timeout: "连接超时",
  dns_error: "域名解析失败",
  blocked: "连接受阻",
  not_configured: "未配置",
} as const;
const HOST_LABELS = {
  loopback: "回环地址",
  private: "私有网络地址",
  public: "公共网络地址",
  local_name: "本地主机名",
  unknown: "未知",
} as const;

// Free-form server text is not a safe credential/address display surface. Only
// show bounded symbolic codes; issues are acknowledged by count, never echoed.
const TASK_STATES: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  retrying: "重试中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  unknown: "未知",
  missing: "任务不存在",
};
const FAILURE_CODES: Record<string, string> = {
  MODEL_TIMEOUT: "模型连接超时",
  MODEL_CONNECT_ERROR: "模型连接失败",
  MODEL_RATE_LIMITED: "模型服务限流",
  MODEL_SERVER_ERROR: "模型服务错误",
  MODEL_AUTH_FAILED: "模型认证失败",
  MODEL_BAD_REQUEST: "模型请求无效",
  MODEL_RESPONSE_INVALID: "模型响应格式无效",
  MODEL_EMPTY_RESPONSE: "模型响应为空",
  MODEL_CONFIG_INVALID: "模型配置无效",
  TASK_EXECUTION_TIMEOUT: "任务执行超时",
  TASK_DISPATCH_FAILED: "任务调度失败",
  UNKNOWN: "未知错误",
};
function symbolicLabel(value: string | null | undefined, allowed: Record<string, string>) {
  return value && Object.hasOwn(allowed, value)
    ? `${allowed[value]}（${value}）`
    : "未知（未记录或已隐藏）";
}
const LIMITATION = "仅诊断，不代表已修复；未调用模型或重试生成。配置变更/收费重试需用户确认。";

export function RuntimeRepairReport({ task }: { task: AgentTaskDto | null | undefined }) {
  const result = readTaskRuntimeRepairReport(task?.steps);
  if (result.kind === "missing") return null;
  if (result.kind === "invalid") {
    return (
      <section
        aria-label="运行诊断报告"
        className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-500/10 dark:text-amber-300"
      >
        <h3 className="text-sm font-semibold">运行诊断报告无效</h3>
        <p className="mt-1">最新报告格式错误、版本不受支持或字段不完整，无法确认诊断结果。</p>
        <p className="mt-1">{LIMITATION}</p>
      </section>
    );
  }
  const { report } = result;
  return (
    <section
      aria-label="运行诊断报告"
      className="mt-3 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-700"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">运行诊断报告</h3>
        <Badge tone={report.status === "blocked" ? "danger" : "neutral"}>
          {report.status === "collected" ? "已取得运行诊断" : "诊断受阻"}
        </Badge>
      </div>
      <p className="mt-2 leading-relaxed text-zinc-600 dark:text-zinc-400">{LIMITATION}</p>
      <dl className="mt-2 space-y-1 text-zinc-600 dark:text-zinc-400">
        <div>
          <dt className="inline">业务任务编号：</dt>
          <dd className="inline">{report.taskId ?? "未知（未关联）"}</dd>
        </div>
        <div>
          <dt className="inline">任务状态：</dt>
          <dd className="inline">{symbolicLabel(report.taskState, TASK_STATES)}</dd>
        </div>
        <div>
          <dt className="inline">错误码：</dt>
          <dd className="inline">{symbolicLabel(report.failureCode, FAILURE_CODES)}</dd>
        </div>
        <div>
          <dt className="inline">连接结果：</dt>
          <dd className="inline">
            {report.connectivity ? CONNECTIVITY_LABELS[report.connectivity] : "未知（未记录）"}
          </dd>
        </div>
        <div>
          <dt className="inline">地址类型：</dt>
          <dd className="inline">
            {report.endpoint?.hostKind ? HOST_LABELS[report.endpoint.hostKind] : "未知"}
          </dd>
        </div>
        <div>
          <dt className="inline">端口：</dt>
          <dd className="inline">{report.endpoint?.port ?? "未知（未记录）"}</dd>
        </div>
        <div>
          <dt className="inline">模型调用次数：</dt>
          <dd className="inline">{report.modelCalls}</dd>
        </div>
      </dl>
      {report.issues.length ? (
        <p className="mt-2 text-amber-700 dark:text-amber-400">
          已记录 {report.issues.length} 项诊断问题；为避免泄露地址或凭据，不展示原始问题文本。
        </p>
      ) : null}
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        {report.needsUserAction ? "需要用户处理并确认后续操作。" : "本报告不触发任何后续操作。"}
      </p>
    </section>
  );
}
