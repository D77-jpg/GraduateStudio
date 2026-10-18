import { describe, expect, it } from "vitest";
import {
  createGenerationBatches,
  generationBatchesForPlan,
  implementationOutputTokens,
  selectRelevantGenerationPaths,
  fullProjectModulePrompt,
} from "@/lib/generation-efficiency";
const steps = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file${index}.ts`,
    action: "create" as const,
  }));
describe("generation efficiency without weakening coverage", () => {
  it("packs six small files with full ordered coverage", () => {
    expect(createGenerationBatches(steps(14))).toEqual([
      [0, 1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10, 11],
      [12, 13],
    ]);
  });
  it("limits estimated cost and isolates large existing modifications", () => {
    const plan = steps(7).map((step, index) => ({
      ...step,
      action: index === 2 ? ("modify" as const) : step.action,
    }));
    expect(createGenerationBatches(plan, { "src/file2.ts": 25_000 })).toEqual([
      [0, 1],
      [2],
      [3, 4, 5, 6],
    ]);
    const views = steps(6).map((step) => ({ ...step, path: step.path.replace(".ts", ".vue") }));
    expect(createGenerationBatches(views)).toEqual([
      [0, 1, 2, 3],
      [4, 5],
    ]);
  });
  it("preserves absent legacy boundaries and validates durable boundaries", () => {
    expect(generationBatchesForPlan(steps(5))).toEqual([[0, 1], [2, 3], [4]]);
    expect(generationBatchesForPlan(steps(5), [[0], [1, 2, 3, 4]])).toEqual([[0], [1, 2, 3, 4]]);
    expect(() =>
      generationBatchesForPlan(steps(5), [
        [0, 2],
        [1, 3, 4],
      ]),
    ).toThrow("检查点损坏");
  });
  it("scales token allowance with batch output but never beyond 20k", () => {
    expect(implementationOutputTokens(steps(1))).toBe(12_000);
    expect(implementationOutputTokens(steps(6))).toBe(18_000);
    expect(
      implementationOutputTokens([{ path: "large.ts", action: "modify" }], { "large.ts": 48_000 }),
    ).toBe(20_000);
  });
  it("selects targets and nearby contracts instead of unrelated accumulated files", () => {
    const paths = [
      "src/orders/service.ts",
      "src/api/orders.ts",
      "package.json",
      ...Array.from({ length: 30 }, (_, i) => `src/other${i}.ts`),
    ];
    expect(selectRelevantGenerationPaths(paths, ["src/orders/service.ts"]).slice(0, 3)).toEqual([
      "src/orders/service.ts",
      "src/api/orders.ts",
      "package.json",
    ]);
    expect(selectRelevantGenerationPaths(paths, ["src/orders/service.ts"])).not.toContain(
      "src/other29.ts",
    );
  });
  it("scopes foundation to shared infrastructure and marks satisfied work reuse-only", () => {
    const foundation = {
      id: "foundation",
      title: "基础",
      kind: "foundation" as const,
      dependsOn: [],
      objective: "共享基础",
      acceptanceCriteria: ["可运行"],
      featureIds: [],
    };
    const prompt = fullProjectModulePrompt(
      "目标",
      { title: "全计划", modules: [foundation] },
      foundation,
      ["foundation"],
    );
    expect(prompt).toContain("基础模块仅共享基础设施");
    expect(prompt).toContain("已满足，复用不重做");
    expect(prompt).toContain("文件所有权");
  });
});
