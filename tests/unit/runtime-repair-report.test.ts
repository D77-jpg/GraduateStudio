import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTaskDto } from "@/lib/agent";
import {
  RUNTIME_REPAIR_REPORT_MARKER,
  RuntimeRepairReport,
  readTaskRuntimeRepairReport,
} from "@/components/features/agent/runtime-repair-report";

function report(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    status: "collected",
    taskId: 42,
    taskState: "failed",
    failureCode: "MODEL_CONNECT_ERROR",
    connectivity: "refused",
    endpoint: { hostKind: "loopback", port: 8080 },
    modelCalls: 0,
    issues: [],
    needsUserAction: true,
    ...overrides,
  };
}
function step(value: unknown, index = 1) {
  return { index, detail: RUNTIME_REPAIR_REPORT_MARKER + JSON.stringify(value) };
}
function task(...steps: ReturnType<typeof step>[]): AgentTaskDto {
  return { status: "completed", steps } as AgentTaskDto;
}
function render(value: AgentTaskDto | null | undefined) {
  return renderToStaticMarkup(createElement(RuntimeRepairReport, { task: value }));
}
afterEach(() => vi.unstubAllGlobals());

describe("runtime repair diagnostic report", () => {
  it("hides null tasks and missing reports, including unrelated visual evidence", () => {
    for (const value of [
      null,
      undefined,
      task(),
      task({ index: 1, detail: "DESIGN_REPORT\n{}" }),
      task({ index: 2, detail: "ordinary RUNTIME_REPAIR_REPORT\n{}" }),
    ])
      expect(render(value)).toBe("");
    expect(readTaskRuntimeRepairReport(null)).toEqual({ kind: "missing" });
    expect(readTaskRuntimeRepairReport(undefined)).toEqual({ kind: "missing" });
  });

  it("SSR renders diagnostic facts without certifying repair, model use or visual acceptance", () => {
    const html = render(task(step(report())));
    for (const text of [
      "已取得运行诊断",
      "业务任务编号：",
      ">42<",
      "failed",
      "MODEL_CONNECT_ERROR",
      "连接被拒绝",
      "回环地址",
      ">8080<",
      "模型调用次数：",
      ">0<",
      "仅诊断，不代表已修复；未调用模型或重试生成。配置变更/收费重试需用户确认。",
      "需要用户处理",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("视觉验收");
    expect(html).not.toContain("已修复</");
  });

  it("supports absent optional fields and nullable server metadata", () => {
    const minimal = {
      version: 1,
      status: "blocked",
      taskId: null,
      modelCalls: 0,
      issues: [],
      needsUserAction: false,
    };
    for (const value of [
      minimal,
      { ...minimal, taskState: null, failureCode: null, connectivity: null, endpoint: null },
      { ...minimal, endpoint: { hostKind: null, port: null, serviceId: null } },
    ]) {
      expect(readTaskRuntimeRepairReport(task(step(value)).steps).kind).toBe("report");
      expect(render(task(step(value)))).toContain("诊断受阻");
      expect(render(task(step(value)))).toContain("未知（未关联）");
    }
  });

  it("selects greatest index rather than array order without mutating steps", () => {
    const value = task(step(report({ status: "blocked" }), 20), step(report(), 1));
    const before = [...value.steps];
    expect(render(value)).toContain("诊断受阻");
    expect(render(value)).not.toContain("已取得运行诊断");
    expect(value.steps).toEqual(before);
    expect(readTaskRuntimeRepairReport(task(step(report(), 1), step(null, 1)).steps).kind).toBe(
      "invalid",
    );
    expect(readTaskRuntimeRepairReport(task(step(report(), Number.NaN)).steps).kind).toBe(
      "invalid",
    );
  });

  it.each([
    null,
    { version: 2 },
    report({ status: "repaired" }),
    report({ taskId: -1 }),
    report({ taskId: 1.2 }),
    report({ taskId: Number.MAX_SAFE_INTEGER + 1 }),
    report({ modelCalls: 1 }),
    report({ modelCalls: "0" }),
    report({ needsUserAction: "true" }),
    report({ issues: "bad" }),
    report({ issues: Array(51).fill("issue") }),
    report({ issues: ["x".repeat(2049)] }),
    report({ connectivity: "success" }),
    report({ endpoint: { hostKind: "loopback", port: 65536 } }),
    report({ endpoint: { hostKind: "loopback", port: 0 } }),
    report({ endpoint: { hostKind: "loopback", port: 1.1 } }),
    report({ failureCode: "x".repeat(2049) }),
  ])("fails closed on invalid latest schema without falling back: %j", (invalid) => {
    const value = task(step(invalid, 9), step(report(), 1));
    expect(readTaskRuntimeRepairReport(value.steps)).toEqual({ kind: "invalid" });
    expect(render(value)).toContain("运行诊断报告无效");
    expect(render(value)).not.toContain("已取得运行诊断");
  });

  it.each([
    "RUNTIME_REPAIR_REPORT",
    "RUNTIME_REPAIR_REPORT\n",
    "RUNTIME_REPAIR_REPORT\n{",
    "RUNTIME_REPAIR_REPORT\r\n{}",
    "RUNTIME_REPAIR_REPORT\n" + " ".repeat(128_001),
  ])("does not hide a malformed latest marker or JSON", (detail) => {
    const value = task(step(report(), 1), { index: 4, detail });
    expect(readTaskRuntimeRepairReport(value.steps).kind).toBe("invalid");
    expect(render(value)).toContain("运行诊断报告无效");
  });

  it("strips unknown metadata, including visual claims and nested raw endpoint fields", () => {
    const value = task(
      step(
        report({
          visual: { status: "passed" },
          token: "sk-secret-token",
          endpoint: {
            hostKind: "private",
            port: 3000,
            url: "https://user:password@private.test",
            serviceId: 3,
          },
        }),
      ),
    );
    const parsed = readTaskRuntimeRepairReport(value.steps);
    expect(parsed.kind).toBe("report");
    if (parsed.kind === "report") {
      expect(parsed.report).not.toHaveProperty("visual");
      expect(parsed.report).not.toHaveProperty("token");
      expect(parsed.report.endpoint).toEqual({ hostKind: "private", port: 3000 });
    }
    const html = render(value);
    for (const secret of ["sk-secret-token", "private.test", "password", "passed", "visual"])
      expect(html).not.toContain(secret);
  });

  it("never interprets or echoes persisted HTML, raw URLs or credentials", () => {
    const html = render(
      task(
        step(
          report({
            taskState: '<script>alert("x")</script>',
            failureCode: "https://user:secret@host",
            issues: [
              "<img src=x onerror=alert(1)>",
              "Bearer sk-secret",
              "http://localhost:8080?token=secret",
            ],
          }),
        ),
      ),
    );
    expect(html).toContain("已记录 3 项诊断问题");
    for (const unsafe of [
      "<script",
      "<img",
      "&lt;script",
      "https://",
      "http://",
      "sk-secret",
      "onerror",
      "href=",
    ])
      expect(html).not.toContain(unsafe);
  });

  it("hides credential-shaped values even when they resemble symbolic codes", () => {
    const html = render(
      task(step(report({ taskState: "sk_secret_token", failureCode: "BearerSecretToken" }))),
    );
    expect(html).not.toContain("sk_secret_token");
    expect(html).not.toContain("BearerSecretToken");
    expect(html).toContain("未知（未记录或已隐藏）");
  });

  it.each(["connected", "refused", "timeout", "dns_error", "blocked", "not_configured"])(
    "supports connectivity %s",
    (connectivity) => {
      expect(readTaskRuntimeRepairReport(task(step(report({ connectivity }))).steps).kind).toBe(
        "report",
      );
    },
  );

  it("renders locally with zero API/model calls and no executable action", () => {
    const fetch = vi.fn(() => {
      throw new Error("unexpected network/model action");
    });
    vi.stubGlobal("fetch", fetch);
    for (const value of [null, task(), task(step(report())), task(step(null))]) {
      const html = render(value);
      expect(html).not.toContain("<button");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("href=");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
