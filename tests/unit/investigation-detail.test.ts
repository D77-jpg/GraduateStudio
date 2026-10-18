import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InvestigationDetail,
  parseInvestigationDetail,
} from "@/components/features/agent/investigation-detail";

function render(value: unknown) {
  return renderToStaticMarkup(
    createElement(InvestigationDetail, { detail: JSON.stringify(value) }),
  );
}
function observation(tool: string, result: unknown, extra = {}) {
  return {
    hypothesis: "验证订单总额契约",
    id: 0,
    request: { tool, path: "backend/src/orders.ts", ...extra },
    result,
  };
}

describe("readable investigation detail", () => {
  it("shows hypothesis, status, path and summary while keeping numbered source and JSON separately collapsed", () => {
    const html = render(
      observation("read_file", {
        ok: true,
        linesReturned: 2,
        text: "12: const total = 0;\n13: return total;",
        truncated: true,
      }),
    );
    expect(html).toContain("假设：验证订单总额契约");
    expect(html).toContain("状态：观察成功");
    expect(html).toContain("路径：backend/src/orders.ts");
    expect(html).toContain("已读取 2 行");
    expect(html).toContain("输出已截断");
    expect(html).toMatch(
      /<details[^>]*><summary[^>]*>查看带行号的文件内容<\/summary><pre[^>]*>12: const total = 0;/,
    );
    expect(html).toMatch(/<details[^>]*><summary[^>]*>原始 JSON（调试）<\/summary><pre/);
    expect(html).not.toContain(" open");
  });
  it("numbers legacy content from the request offset", () => {
    const value = observation("read_file", { ok: true, content: "first\nsecond" }, { offset: 8 });
    expect(parseInvestigationDetail(JSON.stringify(value))?.output).toBe("8: first\n9: second");
  });
  it("renders failed test output without ANSI styling or claiming acceptance passed", () => {
    const value = observation(
      "node_test",
      {
        ok: false,
        exitCode: 1,
        durationMs: 17,
        output: "\u001b[31mnot ok 1 - total\u001b[0m\n# fail 1",
      },
      { directory: "backend", testPath: "tests/orders.test.js" },
    );
    const display = parseInvestigationDetail(JSON.stringify(value));
    expect(display?.output).toBe("not ok 1 - total\n# fail 1");
    const html = render(value);
    expect(html).toContain("状态：测试失败");
    expect(html).toContain("backend/tests/orders.test.js");
    expect(html).toContain("退出码：1 · 耗时 17 ms");
    expect(html).toContain("查看测试输出");
    expect(html).not.toContain("定向测试通过");
  });
  it("distinguishes a successful targeted test from full acceptance and surfaces blocking reasons", () => {
    expect(render(observation("node_test", { ok: true, exitCode: 0 }))).toContain("不代表完整验收");
    const html = render(
      observation("node_test", {
        ok: false,
        exitCode: null,
        blockedReason: "Database unavailable; no test executed.",
      }),
    );
    expect(html).toContain("工具受阻");
    expect(html).toContain("Database unavailable; no test executed.");
    expect(html).not.toContain("状态：测试失败");
  });
  it.each([
    [
      "list_files",
      { ok: true, entries: [{ path: "backend/src", type: "directory" }] },
      "backend/src/",
      "返回 1 个文件/目录",
    ],
    [
      "search_text",
      { ok: true, hits: [{ path: "backend/src/orders.ts", line: 12, text: "const total = 0" }] },
      "backend/src/orders.ts:12: const total = 0",
      "1 处匹配",
    ],
  ])("renders readable %s evidence", (tool, result, output, summary) => {
    const html = render(observation(tool, result, { directory: "backend", query: "total" }));
    expect(html).toContain(output);
    expect(html).toContain(summary);
    expect(html).not.toContain(" open");
  });
  it.each([
    ["repair", "建议修复（尚未修改代码）"],
    ["environment", "环境阻塞"],
    ["insufficient", "证据不足"],
  ])("renders a %s conclusion with status and evidence paths", (disposition, status) => {
    const html = render({
      checkId: "backend-test",
      disposition,
      summary: "根因已调查",
      paths: ["backend/src/orders.ts", 42],
    });
    expect(html).toContain("调查结论 · backend-test");
    expect(html).toContain(status);
    expect(html).toContain("根因已调查");
    expect(html).toContain("路径：backend/src/orders.ts");
    expect(html).not.toContain("路径：42");
  });
  it("shortens long summaries and retains the complete conclusion in collapsed details", () => {
    const summary = "调查证据".repeat(100);
    const display = parseInvestigationDetail(
      JSON.stringify({ checkId: "backend-test", disposition: "insufficient", summary, paths: [] }),
    );
    expect(display?.summary.length).toBeLessThanOrEqual(241);
    expect(display?.output).toBe(summary);
    expect(
      render({ checkId: "backend-test", disposition: "insufficient", summary, paths: [] }),
    ).toContain("查看完整结论");
  });
  it("escapes untrusted content, handles malformed/unknown JSON, and preserves ordinary diagnostic text", () => {
    const html = render(
      observation("read_file", { ok: true, text: '1: <script>alert("x")</script>' }),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(parseInvestigationDetail("{broken")).toBeNull();
    for (const detail of ["{broken", '{"unknown":"debug"}', "[1,2]"]) {
      const fallback = renderToStaticMarkup(createElement(InvestigationDetail, { detail }));
      expect(fallback).toContain("调查记录格式无法识别");
      expect(fallback).toContain("原始 JSON（调试）");
      expect(fallback).not.toContain(" open");
    }
    expect(
      renderToStaticMarkup(createElement(InvestigationDetail, { detail: "普通错误上下文" })),
    ).toContain("普通错误上下文");
  });
});
