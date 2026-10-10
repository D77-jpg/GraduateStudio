import { describe, expect, it } from "vitest";
import { buildFeatureTree, featureInputSchema, requirementUpdateSchema } from "@/lib/requirements";

const flatRows = [
  { id: "m2", parentId: null, name: "商品系统", description: "", priority: "must", order: 1 },
  { id: "f2b", parentId: "m2", name: "商品搜索", description: "", priority: "must", order: 1 },
  { id: "f2a", parentId: "m2", name: "发布商品", description: "", priority: "must", order: 0 },
  { id: "m1", parentId: null, name: "用户系统", description: "账号", priority: "must", order: 0 },
  { id: "f1a", parentId: "m1", name: "注册", description: "", priority: "must", order: 0 },
  { id: "f1b", parentId: "m1", name: "登录", description: "", priority: "should", order: 1 },
];

describe("buildFeatureTree", () => {
  it("builds a two-level tree ordered by `order`", () => {
    const tree = buildFeatureTree(flatRows);
    expect(tree.map((module) => module.name)).toEqual(["用户系统", "商品系统"]);
    expect(tree[0].children.map((child) => child.name)).toEqual(["注册", "登录"]);
    expect(tree[1].children.map((child) => child.name)).toEqual(["发布商品", "商品搜索"]);
  });

  it("handles empty input", () => {
    expect(buildFeatureTree([])).toEqual([]);
  });

  it("keeps priority values", () => {
    const tree = buildFeatureTree(flatRows);
    expect(tree[0].children[1].priority).toBe("should");
  });
});

describe("featureInputSchema", () => {
  it("accepts valid feature and defaults priority/description", () => {
    const parsed = featureInputSchema.parse({ name: "登录" });
    expect(parsed).toEqual({ name: "登录", description: "", priority: "should" });
  });

  it("rejects empty name", () => {
    expect(featureInputSchema.safeParse({ name: "  " }).success).toBe(false);
  });
});

describe("requirementUpdateSchema", () => {
  it("accepts partial updates", () => {
    const parsed = requirementUpdateSchema.parse({ goals: ["目标一"] });
    expect(parsed.goals).toEqual(["目标一"]);
    expect(parsed.roles).toBeUndefined();
  });

  it("accepts full role replacement", () => {
    const parsed = requirementUpdateSchema.parse({
      roles: [
        { name: "学生用户", description: "买家/卖家" },
        { name: "管理员", description: "" },
      ],
    });
    expect(parsed.roles).toHaveLength(2);
  });

  it("rejects roles with empty name", () => {
    expect(requirementUpdateSchema.safeParse({ roles: [{ name: "" }] }).success).toBe(false);
  });
});
