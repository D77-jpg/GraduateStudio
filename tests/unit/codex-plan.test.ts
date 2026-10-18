import { describe, it, expect } from "vitest";
import { validateCodexPlan } from "@/server/agents/codex-plan";
const module = (id: string, dependsOn: string[] = [], featureIds: string[] = []) => ({
  id,
  title: id,
  dependsOn,
  featureIds,
  acceptanceCriteria: ["real check"],
});
describe("Codex full project plan", () => {
  it("orders modules and covers saved requirements", () => {
    expect(
      validateCodexPlan({ version: 1, modules: [module("ui", ["api"], ["f"]), module("api")] }, [
        "f",
      ]).modules.map((m) => m.id),
    ).toEqual(["api", "ui"]);
  });
  it("rejects missing coverage, invented IDs and cycles", () => {
    expect(() => validateCodexPlan({ version: 1, modules: [module("a")] }, ["f"])).toThrow(
      "缺少需求覆盖",
    );
    expect(() => validateCodexPlan({ version: 1, modules: [module("a", [], ["x"])] }, [])).toThrow(
      "未知需求",
    );
    expect(() =>
      validateCodexPlan({ version: 1, modules: [module("a", ["b"]), module("b", ["a"])] }, []),
    ).toThrow("循环");
  });
});
