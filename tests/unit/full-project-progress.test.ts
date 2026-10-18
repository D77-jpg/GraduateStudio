import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTaskDto } from "@/lib/agent";
import {
  FULL_PROJECT_CHECKPOINT_MARKER,
  readFullProjectCheckpoint,
  getFullProjectExecutionState,
  getFullProjectRequestState,
  formatFullProjectDuration,
  formatFullProjectStepTitle,
  FullProjectProgress,
} from "@/components/features/agent/full-project-progress";

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    phase: "blocked",
    plan: { modules: [{ id: "base", title: "基础" }] },
    completedModuleIds: [],
    currentModule: null,
    modelCalls: 10,
    repairAttempts: 0,
    elapsedMs: 1000,
    activeSince: null,
    nextStepIndex: 10,
    maxSteps: 240,
    ...overrides,
  };
}
function task(value: Record<string, unknown>, status = "failed"): AgentTaskDto {
  return {
    title: "[完整生成] 测试",
    status,
    steps: [{ index: 1, detail: FULL_PROJECT_CHECKPOINT_MARKER + JSON.stringify(value) }],
  } as unknown as AgentTaskDto;
}

describe("full project pure progress display", () => {
  it("reports factual counters only, without execution limits", () => {
    expect(getFullProjectExecutionState(task(checkpoint()), 5000)).toEqual({
      elapsedMs: 1000,
      activeSince: null,
      nextStepIndex: 10,
      modelCalls: 10,
    });
  });
  it("counts only active wall time, including recovery", () => {
    const value = checkpoint({ activeSince: 1000, elapsedMs: 2000, modelCalls: 80 });
    expect(getFullProjectExecutionState(task(value), 5000)).toMatchObject({ elapsedMs: 6000 });
    expect(getFullProjectExecutionState(task(value), 500)).toMatchObject({ elapsedMs: 2000 });
  });
  it.each([
    { version: 2 },
    { maxSteps: 0 },
    { maxModelCalls: "bad" },
    { maxWallMs: "bad" },
    { budgetExtensions: { corrupt: true } },
  ])("ignores retired budget fields while displaying operational progress: %j", (overrides) => {
    expect(getFullProjectExecutionState(task(checkpoint(overrides)))).toMatchObject({
      elapsedMs: 1000,
      nextStepIndex: 10,
      modelCalls: 10,
    });
  });
  it.each([{ elapsedMs: -1 }, { activeSince: "bad" }, { nextStepIndex: 1.5 }])(
    "does not invent unsafe operational counters: %j",
    (overrides) => {
      expect(getFullProjectExecutionState(task(checkpoint(overrides)))).toBeNull();
      expect(readFullProjectCheckpoint(task(checkpoint(overrides)))?.modules).toHaveLength(1);
    },
  );
  it("renders high counters without denominators, warnings or extension prompts", () => {
    const html = renderToStaticMarkup(
      createElement(FullProjectProgress, {
        task: task(checkpoint({ nextStepIndex: 9999, modelCalls: 8888, elapsedMs: 9999999 })),
      }),
    );
    expect(html).toContain("执行步骤 9999 步");
    expect(html).toContain("调用记录 8888 次");
    for (const retired of ["预算", "追加", "额度", "80%", " / 240", " / 100"])
      expect(html).not.toContain(retired);
  });
  it("parses optional saved execution timings without equating them with budget calls", () => {
    const stats = {
      modelMs: 1400,
      modelCalls: 2,
      stepMs: 2500,
      steps: 3,
      lastModelMs: 500,
      lastStepMs: 1000,
    };
    const value = task(checkpoint({ executionStats: stats }));
    expect(readFullProjectCheckpoint(value)?.executionStats).toEqual(stats);
    expect(getFullProjectExecutionState(value)?.modelCalls).toBe(10);
    expect(
      readFullProjectCheckpoint(task(checkpoint({ executionStats: { ...stats, modelMs: -1 } }))),
    ).toBeNull();
    expect(readFullProjectCheckpoint(task(checkpoint()))?.executionStats).toBeNull();
    expect(formatFullProjectDuration(61_999)).toBe("1 分 1 秒");
  });
  const request = {
    type: "completed",
    provider: "exact-provider",
    model: "exact-model",
    requestedBudget: 4800,
    attempt: 2,
    durationMs: 61_999,
    textChars: 125,
    reasoningChars: 900,
    finishReason: "stop",
    updatedAt: "2026-01-02T03:04:05.000Z",
  };
  it("accepts requests with no platform output cap", () => {
    const uncapped = { ...request, requestedBudget: undefined };
    const value = task(checkpoint({ lastRequest: uncapped }));
    expect(readFullProjectCheckpoint(value)?.lastRequest).toEqual(uncapped);
    const html = renderToStaticMarkup(createElement(FullProjectProgress, { task: value }));
    expect(html).toContain("未设置平台输出上限");
    expect(html).not.toContain("undefined");
  });
  it("preserves old checkpoints and reads only safe request metadata", () => {
    expect(readFullProjectCheckpoint(task(checkpoint()))).toMatchObject({
      actualRequests: null,
      lastRequest: null,
    });
    const parsed = readFullProjectCheckpoint(
      task(checkpoint({ actualRequests: 3, lastRequest: { ...request, reasoning: "PRIVATE" } })),
    );
    expect(parsed?.actualRequests).toBe(3);
    expect(parsed?.lastRequest).toEqual(request);
  });
  it.each([
    { type: "streaming" },
    { attempt: 0 },
    { requestedBudget: -1 },
    { durationMs: -1 },
    { textChars: 1.5 },
    { reasoningChars: -1 },
    { firstResponseMs: -1 },
    { firstResponseMs: "1" },
    { inputTokens: -1 },
    { outputTokens: 1.5 },
    { reasoningTokens: "900" },
    { outputTokens: null },
    { updatedAt: "yesterday" },
    { errorKind: "other" },
    { finishReason: 1 },
    { provider: null },
    { model: [] },
  ])("fails closed on malformed latest request metadata: %j", (invalid) => {
    const value = task(checkpoint());
    value.steps.push({
      index: 2,
      detail:
        FULL_PROJECT_CHECKPOINT_MARKER +
        JSON.stringify(checkpoint({ lastRequest: { ...request, ...invalid } })),
    } as AgentTaskDto["steps"][number]);
    expect(readFullProjectCheckpoint(value)).toBeNull();
  });
  it.each([-1, 0.5, "3", null])("rejects malformed actual request counts: %j", (actualRequests) => {
    expect(readFullProjectCheckpoint(task(checkpoint({ actualRequests })))).toBeNull();
  });
  it("shows reported duration, exact target, character counts and separate counters without reasoning", () => {
    const html = renderToStaticMarkup(
      createElement(FullProjectProgress, {
        task: task(
          checkpoint({ actualRequests: 3, lastRequest: { ...request, reasoning: "PRIVATE" } }),
        ),
      }),
    );
    for (const text of [
      "exact-provider",
      "exact-model",
      "4800 tokens",
      "第 2 次尝试",
      "1 分 1 秒",
      "输出 125 字符",
      "实际请求 3 次",
      "调用记录",
      "连接与执行详情",
      "模块进度不代表最终验收结果",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("PRIVATE");
    expect(html).not.toContain("900 字符");
  });
  it("reports started requests without implying gateway progress", () => {
    const html = renderToStaticMarkup(
      createElement(FullProjectProgress, {
        task: task(
          checkpoint({ lastRequest: { ...request, type: "started", durationMs: 0, textChars: 0 } }),
          "coding",
        ),
      }),
    );
    expect(html).toContain("正在生成代码 · 等待返回");
    expect(html).toContain("已等待 0 秒");
    expect(html).toContain("尚未收到响应；等待时长不代表模型生成进度");
    expect(html).not.toContain("模型正在推进");
    expect(html).not.toContain("请求诊断");
    expect(html).not.toContain("输出 0 字符");
  });
  it("accepts active progress and keeps elapsed time from the original request across updates", () => {
    const progress = { ...request, type: "progress", durationMs: 30_000, firstResponseMs: 2500 };
    const parsed = readFullProjectCheckpoint(
      task(checkpoint({ lastRequest: progress }), "coding"),
    )?.lastRequest;
    expect(parsed).toEqual(progress);
    expect(getFullProjectRequestState(parsed!, Date.parse(request.updatedAt) + 5000)).toEqual({
      active: true,
      elapsedMs: 35_000,
    });
    const next = { ...parsed!, updatedAt: "2026-01-02T03:04:10.000Z", durationMs: 35_000 };
    expect(getFullProjectRequestState(next, Date.parse(next.updatedAt) + 2000)).toEqual({
      active: true,
      elapsedMs: 37_000,
    });
    expect(getFullProjectRequestState(next, Date.parse(next.updatedAt) - 1000).elapsedMs).toBe(
      35_000,
    );
    expect(
      getFullProjectRequestState({ ...next, type: "completed" }, Date.parse(next.updatedAt) + 9000),
    ).toEqual({
      active: false,
      elapsedMs: 35_000,
    });
    expect(getFullProjectRequestState({ ...next, type: "started" }).active).toBe(true);
    expect(getFullProjectRequestState({ ...next, type: "failed" }).active).toBe(false);
  });
  it("shows actual accumulated content but not private reasoning or inferred tokens", () => {
    const html = renderToStaticMarkup(
      createElement(FullProjectProgress, {
        task: task(
          checkpoint({
            lastRequest: { ...request, type: "progress", durationMs: 30_000, reasoning: "PRIVATE" },
          }),
          "coding",
        ),
      }),
    );
    const main = html.slice(0, html.indexOf("<details"));
    expect(main).toContain("正在接收生成内容");
    expect(main).toContain("请求已进行 30 秒");
    expect(main).toContain("已接收 125 字符");
    expect(html).not.toContain("900 字符");
    expect(html).not.toContain("PRIVATE");
    expect(html).not.toContain("服务返回用量");
    expect(html).not.toContain("完整输出返回后");
    expect(html).not.toContain("不逐字流式");
  });
  it("distinguishes a service response with only reasoning from received generated content", () => {
    const html = renderToStaticMarkup(
      createElement(FullProjectProgress, {
        task: task(
          checkpoint({ lastRequest: { ...request, type: "progress", textChars: 0 } }),
          "coding",
        ),
      }),
    );
    const main = html.slice(0, html.indexOf("<details"));
    expect(main).toContain("服务已响应 · 等待生成内容");
    expect(main).not.toContain("正在接收生成内容");
    expect(main).not.toContain("已接收");
  });
  it("shows only exact returned usage in collapsed details, including reported zero", () => {
    const metrics = {
      firstResponseMs: 2500,
      inputTokens: 321,
      outputTokens: 0,
      reasoningTokens: 987,
    };
    const value = task(checkpoint({ lastRequest: { ...request, ...metrics } }));
    expect(readFullProjectCheckpoint(value)?.lastRequest).toMatchObject(metrics);
    const html = renderToStaticMarkup(createElement(FullProjectProgress, { task: value }));
    const main = html.slice(0, html.indexOf("<details"));
    const details = html.slice(html.indexOf("<details"));
    expect(main).not.toContain("tokens");
    expect(main).not.toContain("首次响应");
    expect(details).toContain("首段可识别内容耗时 2 秒");
    expect(details).toContain("输入 321 tokens · 输出 0 tokens · 推理 987 tokens");
    expect(details).not.toContain("<details open");
    const partial = renderToStaticMarkup(
      createElement(FullProjectProgress, {
        task: task(checkpoint({ lastRequest: { ...request, inputTokens: 123 } })),
      }),
    );
    expect(partial).toContain("输入 123 tokens");
    expect(partial).not.toContain("输出 0 tokens");
    expect(partial).not.toContain("推理 900 tokens");
  });
  it("puts the friendly current request first and hides connection/accounting details by default", () => {
    const html = renderToStaticMarkup(
      createElement(FullProjectProgress, {
        task: task(
          checkpoint({
            actualRequests: 3,
            completedModuleIds: ["base"],
            lastRequest: {
              ...request,
              provider: "openai",
              model: "deepseek-flash",
              type: "started",
              durationMs: 0,
              textChars: 0,
              reasoning: "PRIVATE_REASONING",
              apiKey: "PRIVATE_SECRET",
            },
            error: "PRIVATE_RAW_FAILURE",
            executionStats: { modelMs: 1400, modelCalls: 2, stepMs: 2500, steps: 3 },
          }),
          "coding",
        ),
      }),
    );
    const main = html.slice(0, html.indexOf("<details"));
    const details = html.slice(html.indexOf("<details"));
    expect(main).toContain("请求模型：deepseek-flash");
    expect(main).toContain("已运行 1 秒");
    expect(main).toContain("已等待 0 秒");
    expect(main).toContain("已完成 1 / 1 个模块");
    expect(main.indexOf("当前代码生成请求")).toBeLessThan(main.indexOf("已完成 1 / 1"));
    for (const hidden of ["openai", "调用记录", "实际请求", "4800 tokens", "调用耗时", "执行步骤"])
      expect(main).not.toContain(hidden);
    expect(details).toContain("提供方：openai · 模型：deepseek-flash");
    expect(details).toContain("实际请求 3 次");
    expect(details).toContain("调用记录 10 次");
    expect(details).toContain("连接与执行详情");
    expect(details).not.toMatch(/<details[^>]*\\bopen(?:[\\s=>])/);
    for (const internal of [
      "PRIVATE_REASONING",
      "PRIVATE_SECRET",
      "PRIVATE_RAW_FAILURE",
      "历史 +",
      "诊断启用后",
    ])
      expect(html).not.toContain(internal);
    expect(
      readFullProjectCheckpoint(
        task(
          checkpoint({ lastRequest: { ...request, provider: "openai", model: "deepseek-flash" } }),
        ),
      )?.lastRequest?.model,
    ).toBe("deepseek-flash");
  });
  it("does not relabel legacy call records as actual requests", () => {
    const html = renderToStaticMarkup(
      createElement(FullProjectProgress, { task: task(checkpoint()) }),
    );
    expect(html).toContain("调用记录 10 次");
    expect(html).toContain("实际请求计数未记录");
    expect(html).not.toContain("实际请求 10 次");
  });
  it.each([
    ["timeout", "请求超时"],
    ["cancelled", "请求已取消"],
    ["network", "网络或服务连接失败"],
    ["invalid-json", "返回结果不是有效 JSON"],
  ])("labels failed requests in Chinese: %s", (errorKind, label) => {
    const html = renderToStaticMarkup(
      createElement(FullProjectProgress, {
        task: task(checkpoint({ lastRequest: { ...request, type: "failed", errorKind } })),
      }),
    );
    expect(html).toContain(label);
  });
  it("uses module titles and human batch numbers without exposing internal identifiers", () => {
    expect(
      formatFullProjectStepTitle(task(checkpoint()), "FULL_PROJECT_BATCH:task-id:base:0"),
    ).toBe("生成模块：基础 · 第 1 批");
    expect(
      formatFullProjectStepTitle(task(checkpoint()), "FULL_PROJECT_BATCH:task-id:unknown:2"),
    ).toBe("生成模块代码 · 第 3 批");
    expect(formatFullProjectStepTitle(task(checkpoint()), "FULL_PROJECT_BATCH:invalid")).toBe(
      "生成模块代码批次",
    );
    expect(
      formatFullProjectStepTitle(task(checkpoint()), "FULL_PROJECT_BATCH:task-id:base:files-12-13"),
    ).toBe("生成模块：基础 · 生成 2 个文件");
    expect(
      formatFullProjectStepTitle(
        task(checkpoint()),
        "FULL_PROJECT_BATCH:task-id:unknown:files-12-13",
      ),
    ).toBe("生成模块代码 · 生成 2 个文件");
    expect(formatFullProjectStepTitle(task(checkpoint()), "普通步骤")).toBe("普通步骤");
  });
  it("numbers stable batches by module execution order and retains retry numbers", () => {
    const value = task(checkpoint());
    const titles = [
      "FULL_PROJECT_BATCH:task-id:base:0",
      "FULL_PROJECT_BATCH:task-id:base:files-12-13",
      "FULL_PROJECT_BATCH:task-id:base:files-12-13",
      "FULL_PROJECT_BATCH:task-id:base:files-14",
    ];
    value.steps.push(
      ...titles.map((title, index) => ({
        ...value.steps[0],
        id: `batch-${index}`,
        index: index + 10,
        title,
        detail: "",
      })),
    );
    expect(formatFullProjectStepTitle(value, titles[1])).toBe(
      "生成模块：基础 · 第 2 批 · 2 个文件",
    );
    expect(formatFullProjectStepTitle(value, titles[3])).toBe(
      "生成模块：基础 · 第 3 批 · 1 个文件",
    );
    expect(value.steps.slice(-4).map((step) => step.index)).toEqual([10, 11, 12, 13]);
  });
  it("preserves original module progress during repair and names repair batches", () => {
    const value = task(
      checkpoint({
        phase: "repair",
        currentModule: { id: "repair-2", title: "验收修复 2" },
        completedModuleIds: ["base", "repair-1"],
        repairAttempts: 2,
      }),
      "fixing",
    );
    expect(readFullProjectCheckpoint(value)?.modules).toEqual([{ id: "base", title: "基础" }]);
    const html = renderToStaticMarkup(createElement(FullProjectProgress, { task: value }));
    expect(html).toContain("第 2 轮验收修复");
    expect(html).toContain("已完成 1 / 1 个模块");
    expect(html).not.toContain("当前进度暂时无法确认");
    expect(formatFullProjectStepTitle(value, "FULL_PROJECT_BATCH:task-id:repair-2:files-9")).toBe(
      "第 2 轮验收修复 · 生成 1 个文件",
    );
    expect(
      readFullProjectCheckpoint(task(checkpoint({ completedModuleIds: ["unknown"] }))),
    ).toBeNull();
  });
  it("never falls back to an older checkpoint after malformed latest data", () => {
    const value = task(checkpoint({ modelCalls: 100 }));
    value.steps.push({
      index: 2,
      detail: FULL_PROJECT_CHECKPOINT_MARKER + "{bad",
    } as AgentTaskDto["steps"][number]);
    expect(readFullProjectCheckpoint(value)).toBeNull();
    expect(getFullProjectExecutionState(value)).toBeNull();
  });
});
