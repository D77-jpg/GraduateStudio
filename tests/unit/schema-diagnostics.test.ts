import { describe, expect, it } from "vitest";
import { z } from "zod";
import { planOutputSchema, implementOutputSchema } from "@/lib/develop";
import { summarizeSchemaIssues } from "@/server/ai/schema-diagnostics";
const plan = {
  title: "计划",
  summary: "完整模块说明",
  steps: [{ action: "create", path: "src/a.ts", reason: "说明" }],
  risks: "",
};
describe("unrestricted descriptions and safe schema field diagnostics", () => {
  it("accepts long plan and implementation prose without limits", () => {
    const long = "说明".repeat(10000);
    expect(
      planOutputSchema.safeParse({
        ...plan,
        title: long,
        summary: long,
        risks: long,
        steps: [{ ...plan.steps[0], reason: long }],
      }).success,
    ).toBe(true);
    expect(
      implementOutputSchema.safeParse({
        notes: long,
        changes: [{ action: "create", path: "src/a.ts", content: "code" }],
      }).success,
    ).toBe(true);
  });
  it("preserves action and path validation and names the exact field without rejected values", () => {
    const result = planOutputSchema.safeParse({
      ...plan,
      steps: [{ action: "private-secret-key", path: "x".repeat(201), reason: 42 }],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("invalid fixture");
    const summary = summarizeSchemaIssues(result.error);
    expect(summary).toContain("steps[0].action：动作必须是 create、modify 或 delete");
    expect(summary).toContain("steps[0].path：超过");
    expect(summary).toContain("steps[0].reason：缺少必需字段或类型不正确");
    expect(summary).not.toContain("private-secret-key");
  });
  it("reports missing required fields", () => {
    const { risks: ignored, ...missing } = plan;
    void ignored;
    const result = planOutputSchema.safeParse(missing);
    if (result.success) throw new Error("invalid fixture");
    expect(summarizeSchemaIssues(result.error)).toContain("risks：");
  });
  it("does not expose arbitrary unknown keys or custom validator messages", () => {
    const result = z.object({}).strict().safeParse({ "secret-key": 1 });
    if (result.success) throw new Error("invalid fixture");
    expect(summarizeSchemaIssues(result.error)).not.toContain("secret-key");
  });
});
