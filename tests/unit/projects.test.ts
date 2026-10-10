import { describe, expect, it } from "vitest";
import { projectCreateSchema, topicScoresSchema } from "@/lib/projects";
import {
  topicProposalPrompt,
  requirementPrompt,
  moduleRegeneratePrompt,
} from "@/server/ai/prompts";

describe("projectCreateSchema", () => {
  it("applies defaults for a minimal manual create", () => {
    const parsed = projectCreateSchema.parse({ name: "校园二手交易平台" });
    expect(parsed.type).toBe("web");
    expect(parsed.techStack).toEqual([]);
    expect(parsed.goals).toEqual([]);
    expect(parsed.needsAi).toBe(false);
    expect(parsed.scores).toBeUndefined();
  });

  it("rejects a too-short name", () => {
    expect(projectCreateSchema.safeParse({ name: "x" }).success).toBe(false);
  });

  it("validates scores bounds", () => {
    const valid = topicScoresSchema.safeParse({
      innovation: 82,
      implementDifficulty: 71,
      paperFriendliness: 95,
      defense: 93,
      overall: 87,
    });
    expect(valid.success).toBe(true);

    const invalid = topicScoresSchema.safeParse({
      innovation: 182,
      implementDifficulty: 71,
      paperFriendliness: 95,
      defense: 93,
      overall: 87,
    });
    expect(invalid.success).toBe(false);
  });
});

describe("prompt builders", () => {
  it("embeds the idea and preferences", () => {
    const { prompt } = topicProposalPrompt({
      idea: "我想做一个校园二手交易系统",
      devLanguage: "Java",
      needsAi: true,
    });
    expect(prompt).toContain("校园二手交易系统");
    expect(prompt).toContain("Java");
    expect(prompt).toContain("AI 能力");
  });

  it("embeds project context in requirement prompt", () => {
    const { prompt } = requirementPrompt({
      name: "校园二手交易平台",
      description: "基于 Vue 3 与 Spring Boot",
      type: "web",
      techStack: ["Vue 3", "Spring Boot"],
      difficulty: "medium",
    });
    expect(prompt).toContain("校园二手交易平台");
    expect(prompt).toContain("Vue 3");
  });

  it("lists sibling modules for module regeneration", () => {
    const { prompt } = moduleRegeneratePrompt({
      project: { name: "校园二手交易平台", type: "web", techStack: [] },
      moduleName: "交易系统",
      moduleDescription: "订单流程",
      siblingModules: ["用户系统", "商品系统"],
    });
    expect(prompt).toContain("交易系统");
    expect(prompt).toContain("用户系统、商品系统");
  });
});
