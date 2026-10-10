import { describe, expect, it } from "vitest";
import {
  PROJECT_STAGES,
  PROJECT_TOOLS,
  STAGE_LABELS,
  STAGE_METADATA,
  STAGE_ROUTES,
  projectCreateSchema,
  projectDtoSchema,
  stageFromPath,
  stageIndex,
  stageRoute,
  topicScoresSchema,
} from "@/lib/projects";
import {
  topicProposalPrompt,
  requirementPrompt,
  moduleRegeneratePrompt,
} from "@/server/ai/prompts";

describe("canonical project stages", () => {
  it("orders the complete graduation journey without introducing new persisted keys", () => {
    expect(PROJECT_STAGES).toEqual([
      "topic",
      "requirements",
      "architecture",
      "design",
      "database",
      "coding",
      "testing",
      "deploy",
      "docs",
      "defense",
    ]);
    expect(PROJECT_STAGES.map((stage) => STAGE_LABELS[stage])).toEqual([
      "选题规划",
      "需求分析",
      "架构设计",
      "界面设计",
      "数据库设计",
      "AI 开发",
      "测试验证",
      "部署交付",
      "毕设文档",
      "答辩准备",
    ]);
    expect(stageIndex("architecture")).toBeLessThan(stageIndex("design"));
    expect(stageIndex("deploy")).toBeLessThan(stageIndex("docs"));
  });

  it("provides a real route and description for every stage", () => {
    const paths = [
      "",
      "/requirements",
      "/architecture",
      "/develop?stage=design",
      "/database",
      "/develop",
      "/tests",
      "/deploy",
      "/docs",
      "/defense",
    ];
    PROJECT_STAGES.forEach((stage, index) => {
      expect(stageRoute("project-1", stage)).toBe(`/projects/project-1${paths[index]}`);
      expect(STAGE_METADATA[stage].description.length).toBeGreaterThan(0);
      expect(STAGE_ROUTES[stage]).toBe(STAGE_METADATA[stage].route);
    });
    expect(stageRoute("space id", "topic")).toBe("/projects/space%20id");
    expect(stageRoute("project-1", "design")).not.toContain("/design");
  });

  it("retains all backward-compatible stage keys in the persisted DTO schema", () => {
    const historicalKeys = [
      "topic",
      "requirements",
      "design",
      "architecture",
      "database",
      "coding",
      "testing",
      "docs",
      "defense",
      "deploy",
    ];
    historicalKeys.forEach((stage) =>
      expect(projectDtoSchema.shape.stage.safeParse(stage).success).toBe(true),
    );
    expect(projectDtoSchema.shape.stage.safeParse("run").success).toBe(false);
  });

  it("distinguishes design and coding in their shared workspace", () => {
    expect(stageFromPath("p1", "/projects/p1/develop", true)).toBe("design");
    expect(stageFromPath("p1", "/projects/p1/develop")).toBe("coding");
    expect(stageFromPath("p1", "/projects/p1/tests")).toBe("testing");
    expect(stageFromPath("p1", "/projects/p1")).toBe("topic");
    PROJECT_TOOLS.forEach((tool) => {
      expect(stageFromPath("p1", `/projects/p1${tool.path}`)).toBeUndefined();
      expect(PROJECT_STAGES).not.toContain(tool.key);
    });
  });
});

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
