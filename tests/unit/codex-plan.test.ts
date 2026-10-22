import { describe, it, expect } from "vitest";
import { validateCodexPlan, smokeScope } from "@/server/agents/codex-plan";

const write = { kind: "http", as: "admin", method: "POST", path: "/api/items", body: { name: "x{{rand}}" }, expectStatus: 200, saveAs: { itemId: "data.id" } };
const readback = { kind: "http", as: "admin", method: "GET", path: "/api/items/{{itemId}}", expectStatus: 200, expectJson: { "data.name": "*" } };
const page = { kind: "page", as: "admin", route: "/items", expectText: ["物品管理"] };

const module = (id: string, dependsOn: string[] = [], featureIds: string[] = [], smoke: unknown[] = [write, readback, page], extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  dependsOn,
  featureIds,
  acceptanceCriteria: ["real check"],
  smoke,
  ...extra,
});

describe("Codex full project plan v2", () => {
  it("orders modules and covers saved requirements", () => {
    expect(
      validateCodexPlan({ version: 2, modules: [module("ui", ["api"], ["f"]), module("api")] }, ["f"]).modules.map((m) => m.id),
    ).toEqual(["api", "ui"]);
  });
  it("rejects missing coverage, invented IDs and cycles", () => {
    expect(() => validateCodexPlan({ version: 2, modules: [module("a")] }, ["f"])).toThrow("缺少需求覆盖");
    expect(() => validateCodexPlan({ version: 2, modules: [module("a", [], ["x"])] }, [])).toThrow("未知需求");
    expect(() => validateCodexPlan({ version: 2, modules: [module("a", ["b"]), module("b", ["a"])] }, [])).toThrow("循环");
  });
  it("rejects v1 prose-only plans instead of silently accepting unverifiable criteria", () => {
    expect(() =>
      validateCodexPlan({ version: 1, modules: [{ id: "a", title: "a", dependsOn: [], featureIds: [], acceptanceCriteria: ["x"] }] }, []),
    ).toThrow("v1");
  });
  it("requires executable HTTP and page smoke for feature modules", () => {
    expect(() => validateCodexPlan({ version: 2, modules: [module("a", [], ["f"], [page])] }, ["f"])).toThrow("HTTP");
    expect(() => validateCodexPlan({ version: 2, modules: [module("a", [], ["f"], [write, readback])] }, ["f"])).toThrow("页面");
  });
  it("requires write-then-readback unless the module is explicitly read-only", () => {
    const list = { kind: "http", as: "admin", method: "GET", path: "/api/stats", expectStatus: 200 };
    expect(() => validateCodexPlan({ version: 2, modules: [module("a", [], ["f"], [list, page])] }, ["f"])).toThrow("回读");
    expect(validateCodexPlan({ version: 2, modules: [module("a", [], ["f"], [list, page], { readOnly: true })] }, ["f"]).modules).toHaveLength(1);
  });
  it("rejects smoke that references a variable before it is saved", () => {
    expect(() => validateCodexPlan({ version: 2, modules: [module("a", [], ["f"], [readback, write, page])] }, ["f"])).toThrow("未定义变量");
  });
  it("selects regression scope for done modules plus the current one", () => {
    const plan = validateCodexPlan({ version: 2, modules: [module("a", [], ["f"]), module("b", ["a"], ["g"]), module("c", ["b"], ["h"])] }, ["f", "g", "h"]);
    expect(smokeScope(plan, ["a", "b"]).map((s) => s.moduleId)).toEqual(["a", "b"]);
  });
});
