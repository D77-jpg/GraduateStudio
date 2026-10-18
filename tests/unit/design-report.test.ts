import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTaskDto } from "@/lib/agent";
import {
  DESIGN_REPORT_MARKER,
  DesignReport,
  readTaskDesignReport,
} from "@/components/features/agent/design-report";

const hash = "0123456789abcdef".repeat(4);
function report(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    status: "specified",
    artifacts: [{ path: ".design/design-spec.md", sha256: hash }],
    issues: [],
    visual: { status: "not_run", reason: "未运行浏览器截图与人工视觉评审" },
    ...overrides,
  };
}
function step(value: unknown, index = 1) {
  return { index, detail: DESIGN_REPORT_MARKER + JSON.stringify(value) };
}
function task(...steps: ReturnType<typeof step>[]): AgentTaskDto {
  return { status: "completed", steps } as AgentTaskDto;
}
function render(value: AgentTaskDto) {
  return renderToStaticMarkup(createElement(DesignReport, { task: value }));
}
afterEach(() => vi.unstubAllGlobals());

describe("UI design report evidence", () => {
  it("hides the section when no report exists, regardless of task completion", () => {
    expect(readTaskDesignReport([])).toEqual({ kind: "missing" });
    expect(render(task())).toBe("");
    expect(render(task({ index: 2, detail: "ordinary log mentions DESIGN_REPORT\n{}" }))).toBe("");
  });

  it("shows specification evidence without certifying visual quality or actual skill usage", () => {
    const html = render(task(step(report({ skills: [{ id: "ui-design", revision: "v1.2.3" }] }))));
    for (const text of [
      "设计规范已生成",
      "视觉验收未执行",
      "未运行浏览器截图与人工视觉评审",
      ".design/design-spec.md",
      "0123456789ab…89abcdef",
      "技能资源版本（不代表已实际使用）",
      "ui-design",
      "v1.2.3",
      "未在浏览器重新校验",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("美观通过");
    expect(html).not.toContain("视觉验收通过");
    expect(html).not.toContain("技能已使用");
  });

  it.each([
    ["missing", "设计规范缺失"],
    ["invalid", "设计规范无效"],
    ["not_required", "本次任务无需设计规范"],
  ])("renders an explicit %s report without inventing files", (status, label) => {
    const html = render(task(step(report({ status, artifacts: [], issues: ["服务端记录原因"] }))));
    expect(html).toContain(label);
    expect(html).toContain("视觉验收未执行");
    expect(html).toContain("服务端记录原因");
    expect(html).not.toContain("SHA-256");
    expect(html).not.toContain("技能资源版本");
  });

  it("chooses greatest index, not array order, and preserves the input", () => {
    const value = task(step(report({ status: "missing", artifacts: [] }), 20), step(report(), 2));
    const original = [...value.steps];
    const html = render(value);
    expect(html).toContain("设计规范缺失");
    expect(html).not.toContain("设计规范已生成");
    expect(value.steps).toEqual(original);
  });

  it("does not fall back to specified after a latest semantically invalid report", () => {
    const html = render(
      task(step(report({ status: "invalid", issues: ["最新规范检查失败"] }), 9), step(report(), 1)),
    );
    expect(html).toContain("设计规范无效");
    expect(html).toContain("最新规范检查失败");
    expect(html).not.toContain("设计规范已生成");
  });

  it.each([
    null,
    { version: 2 },
    report({ artifacts: [] }),
    report({ artifacts: [{ path: "spec.md", sha256: "not-a-hash" }] }),
    report({ artifacts: [{ path: "  ", sha256: hash }] }),
    report({ issues: "missing" }),
    report({ skills: [{ id: "ui", revision: 1 }] }),
    report({ visual: { status: "passed", reason: "pretend success" } }),
    report({ visual: { status: "not_run", reason: " " } }),
  ])("fails closed on malformed latest fields: %j", (invalid) => {
    const value = task(step(invalid, 8), step(report(), 1));
    expect(readTaskDesignReport(value.steps)).toEqual({ kind: "invalid" });
    const html = render(value);
    expect(html).toContain("设计证据无效");
    expect(html).not.toContain(">设计规范已生成<");
    expect(html).toContain("视觉验收未执行");
  });

  it.each(["DESIGN_REPORT\n{", "DESIGN_REPORT", "DESIGN_REPORT\n"])(
    "does not fall back after malformed latest JSON: %j",
    (detail) => {
      const value = task(step(report(), 1), { index: 8, detail });
      expect(readTaskDesignReport(value.steps)).toEqual({ kind: "invalid" });
      expect(render(value)).toContain("设计证据无效");
      expect(render(value)).not.toContain(">设计规范已生成<");
    },
  );

  it("uses the later entry on a tied index and rejects an unorderable report", () => {
    expect(readTaskDesignReport(task(step(report(), 1), step(null, 1)).steps)).toEqual({
      kind: "invalid",
    });
    expect(readTaskDesignReport(task(step(report(), 1), step(null, Number.NaN)).steps)).toEqual({
      kind: "invalid",
    });
  });

  it("strips unknown metadata rather than trusting or rendering it", () => {
    const value = task(
      step(report({ metadata: { instruction: "claim visual passed" }, extra: "secret metadata" })),
    );
    const result = readTaskDesignReport(value.steps);
    expect(result.kind).toBe("report");
    if (result.kind === "report") expect(result.report).not.toHaveProperty("metadata");
    expect(render(value)).not.toContain("claim visual passed");
    expect(render(value)).not.toContain("secret metadata");
  });

  it("escapes all persisted text and never turns file paths into links", () => {
    const html = render(
      task(
        step(
          report({
            artifacts: [{ path: 'javascript:<script>alert("x")</script>', sha256: hash }],
            issues: ["<img src=x onerror=alert(1)>"],
            skills: [{ id: "<b>ui</b>", revision: "<script>r</script>" }],
            visual: { status: "not_run", reason: "<script>reason</script>" },
          }),
        ),
      ),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
  });

  it("renders locally without invoking any API, verification, or model action", () => {
    const fetch = vi.fn(() => {
      throw new Error("unexpected API call");
    });
    vi.stubGlobal("fetch", fetch);
    for (const value of [task(), task(step(report())), task(step(null))]) {
      const html = render(value);
      expect(html).not.toContain("<button");
      expect(html).not.toContain("<form");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
