import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTaskDto } from "@/lib/agent";
import type { AcceptanceCheck, AcceptanceReport as Report } from "@/lib/acceptance";
import {
  ACCEPTANCE_REPORT_MARKER,
  AcceptanceReport,
  readTaskAcceptanceReport,
} from "@/components/features/agent/acceptance-report";

const mysqlReason =
  "真实 MySQL 集成测试环境不可用；先配置/启动测试数据库，不能用代码重写或跳过测试替代。";
const backend: AcceptanceCheck = {
  id: "backend-test",
  label: "后端 Node 测试",
  status: "blocked",
  command: "node --test",
  output: `${mysqlReason}\n# tests 20\n# pass 6\n# fail 14`,
  durationMs: 100,
  failureEvidence:
    "test at tests/mysql.test.js:12:1\n集成测试无法连接 MySQL：getaddrinfo ENOTFOUND db",
};
function task(report: unknown, index = 1): AgentTaskDto {
  return {
    status: "failed",
    steps: [{ index, detail: ACCEPTANCE_REPORT_MARKER + JSON.stringify(report) }],
  } as AgentTaskDto;
}
function report(checks: AcceptanceCheck[] = [backend]): Report {
  return { version: 1, status: "blocked", checks, limitations: [] };
}
function render(value: AgentTaskDto) {
  return renderToStaticMarkup(createElement(AcceptanceReport, { task: value }));
}

describe("acceptance blocked evidence display", () => {
  it("surfaces the persisted blocker and concrete action before collapsed output without certifying failures", () => {
    const html = render(task(report()));
    const main = html.slice(0, html.indexOf("<details"));
    for (const text of [
      "验收受阻",
      "先处理验收阻塞，再继续",
      "后端 Node 测试：真实 MySQL 集成测试环境不可用",
      "实际执行验收的环境",
      "主机名、端口、账号权限与测试数据库",
      "不要使用生产数据库",
      "失败数量不能单独证明",
      "环境或配置未改变时反复继续",
      "不会跳过测试或自动视为通过",
    ])
      expect(main).toContain(text);
    expect(html).toContain("# fail 14");
    expect(html).toContain("test at tests/mysql.test.js:12:1");
    expect(html).toContain("ENOTFOUND db");
    expect(html).toContain("查看具体失败证据（独立于检查输出）");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("工程检查通过</");
  });

  it("preserves validated failure evidence and warns visibly when collection is incomplete", () => {
    const value = task(report([{ ...backend, failureEvidenceIncomplete: true }]));
    const parsed = readTaskAcceptanceReport(value.steps);
    expect(parsed.kind).toBe("report");
    if (parsed.kind === "report")
      expect(parsed.report.checks[0]).toEqual({ ...backend, failureEvidenceIncomplete: true });
    const html = render(value);
    expect(html).toContain("失败证据收集不完整，不能据此声称已定位全部失败");
    expect(html.indexOf("失败证据收集不完整")).toBeLessThan(html.indexOf("查看具体失败证据"));
  });

  it("keeps legacy reports valid and gives generic guidance for other blockers", () => {
    const html = render(
      task(
        report([
          {
            id: "frontend-test",
            label: "前端测试",
            status: "blocked",
            command: undefined,
            output: "未声明 test 测试脚本，无法证明测试通过。",
            durationMs: 0,
          },
        ]),
      ),
    );
    expect(html).toContain("前端测试：未声明 test 测试脚本");
    expect(html).toContain("补齐工具、依赖、测试或外部环境");
    expect(html).not.toContain("真实 MySQL 测试库");
    expect(html).not.toContain("查看具体失败证据");
  });

  it("shows unknown metadata on executed checks instead of claiming zero time or non-execution", () => {
    const value = task({
      ...report(),
      status: "passed",
      checks: [
        {
          id: "post-apply-0",
          label: "server:python:tests",
          status: "passed",
          output: "pytest evidence: tests=3",
        },
      ],
    });
    expect(readTaskAcceptanceReport(value.steps).kind).toBe("report");
    const html = render(value);
    expect(html).toContain("工程检查通过");
    expect(html).toContain("耗时未知（未记录）");
    expect(html).toContain("命令：未知（未记录）");
    expect(html).not.toContain("耗时 0 ms");
    expect(html).not.toContain("静态检查或未执行");
  });

  it.each([0, 1234.5])(
    "preserves a recorded duration of %s and an actual command",
    (durationMs) => {
      const html = render(
        task(report([{ ...backend, durationMs, command: "python -m pytest -q" }])),
      );
      expect(html).toContain(`耗时 ${durationMs.toLocaleString("zh-CN")} ms`);
      expect(html).toContain("<code>python -m pytest -q</code>");
      expect(html).not.toContain("未知（未记录）");
    },
  );

  it("does not infer execution status from a whitespace-only command", () => {
    const html = render(task(report([{ ...backend, command: "  " }])));
    expect(html).toContain("命令：未知（未记录）");
    expect(html).not.toContain("静态检查或未执行");
  });

  it("does not infer an environment blocker from arbitrary failure text", () => {
    const html = render(
      task({ ...report(), status: "failed", checks: [{ ...backend, status: "failed" }] }),
    );
    expect(html).toContain("验收未通过");
    expect(html).not.toContain("先处理验收阻塞");
    expect(html).not.toContain("不要使用生产数据库");
  });

  it("does not carry a stale blocker forward after a newer passing report", () => {
    const value = task(report());
    value.steps.push(
      ...task(
        {
          ...report(),
          status: "passed",
          checks: [
            {
              ...backend,
              status: "passed",
              output: "# tests 20\n# pass 20\n# fail 0",
              failureEvidence: undefined,
            },
          ],
        },
        2,
      ).steps,
    );
    const html = render(value);
    expect(html).toContain("工程检查通过");
    expect(html).not.toContain("先处理验收阻塞");
    expect(html).not.toContain("ENOTFOUND");
  });

  it.each([{ failureEvidence: 12 }, { failureEvidenceIncomplete: "true" }, { durationMs: -1 }])(
    "fails closed on malformed latest evidence fields: %j",
    (invalid) => {
      const value = task({
        ...report(),
        status: "passed",
        checks: [{ ...backend, status: "passed" }],
      });
      value.steps.push(...task(report([{ ...backend, ...invalid } as AcceptanceCheck]), 2).steps);
      expect(readTaskAcceptanceReport(value.steps)).toEqual({ kind: "invalid" });
      expect(render(value)).toContain("验收报告格式无效");
      expect(render(value)).toContain("无法确认工程检查通过");
      expect(render(value)).not.toContain(">工程检查通过</");
    },
  );

  it("escapes persisted evidence as text instead of interpreting HTML or instructions", () => {
    const html = render(
      task(report([{ ...backend, failureEvidence: '<script>alert("x")</script>' }])),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
