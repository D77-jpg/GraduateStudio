import { describe, it, expect } from "vitest";
import {
  isRuntimeRepairRequest,
  createRepairExplorationGuard,
  buildRuntimeRepairInstructions,
} from "@/server/agents/codex-repair-policy";
describe("runtime repair convergence", () => {
  it("requires an explicit repair and business task reference", () => {
    expect(isRuntimeRepairRequest("刚刚执行了任务 #9失败，修复好")).toBe(true);
    expect(isRuntimeRepairRequest("fix task #9")).toBe(true);
    expect(isRuntimeRepairRequest("重构UI")).toBe(false);
    expect(isRuntimeRepairRequest("列出任务9")).toBe(false);
  });
  it("stops elapsed exploration without resetting on tool chatter", () => {
    const g = createRepairExplorationGuard(0);
    g.observeFiles("a", 0);
    g.observeTool("read");
    expect(g.reason(480000)).toContain("8分钟");
  });
  it("resets elapsed and tool budget on actual byte changes", () => {
    const g = createRepairExplorationGuard(0);
    g.observeFiles("a", 0);
    g.observeFiles("b", 400000);
    expect(g.reason(480000)).toBeNull();
  });
  it("limits identical repeated tools", () => {
    const g = createRepairExplorationGuard(0);
    for (let i = 0; i < 5; i++) g.observeTool("same");
    expect(g.reason(1)).toContain("重复5次");
  });
  it("bounds broad exploration as well", () => {
    const g = createRepairExplorationGuard(0);
    for (let i = 0; i < 60; i++) g.observeTool("read" + i);
    expect(g.reason(1)).toContain("60次");
  });
  it("reports diagnostic boundaries and never requests automatic paid retries", () => {
    const p = buildRuntimeRepairInstructions({ status: "blocked" });
    expect(p).toContain("收费调用和配置变更需要用户确认");
    expect(p).toContain("不需要改代码");
    expect(p).toContain("loopback不是宿主机");
  });
});
