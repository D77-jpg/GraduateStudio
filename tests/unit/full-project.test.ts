import { describe, expect, it } from "vitest";
import {
  MODULE_KINDS,
  fullProjectAcceptanceFailureFingerprint,
  orderFullProjectPlan,
  encodeFullProjectCheckpoint,
  parseFullProjectCheckpoint,
  assertFullProjectBudget,
  consumedWallMs,
  fullProjectBatchTitle,
  canRepairFullProjectAcceptance,
  type FullProjectCheckpoint,
  type FullProjectPlan,
} from "@/lib/full-project";

const plan = (): FullProjectPlan => ({
  title: "真实项目",
  modules: MODULE_KINDS.map((kind, index) => ({
    id: kind,
    title: kind,
    kind,
    objective: "实现真实需求业务闭环",
    featureIds: index === 1 ? ["feature"] : [],
    dependsOn: index ? [MODULE_KINDS[index - 1]] : [],
    acceptanceCriteria: ["正常与失败路径有可执行测试"],
  })),
});
const checkpoint = (): FullProjectCheckpoint => ({
  version: 1,
  taskId: "task",
  projectId: "project",
  requirementId: "requirement",
  requirementUpdatedAt: "2026-01-01",
  featureIds: ["feature"],
  message: "自动完成",
  phase: "modules",
  plan: plan(),
  completedModuleIds: ["foundation"],
  currentModule: plan().modules[1],
  currentPlan: {
    title: "业务文件",
    summary: "数据库业务层",
    risks: "",
    steps: [{ action: "create", path: "src/business.ts", reason: "持久化业务层" }],
  },
  batchCursor: 1,
  pendingChangeSetId: "pending",
  appliedChangeSetIds: ["applied"],
  changedFiles: [{ path: "src/base.ts", action: "create" }],
  nextStepIndex: 5,
  modelCalls: 3,
  repairAttempts: 0,
  maxSteps: 240,
  elapsedMs: 1000,
  activeSince: 2000,
  updatedAt: "2026-01-01",
  error: null,
  acceptanceReport: null,
});
describe("full project durable checkpoint", () => {
  it("round trips live streaming counters without storing output content", () => {
    const cp = checkpoint();
    cp.lastRequest = {type:"progress",provider:"deepseek",model:"deepseek-flash",requestedBudget:393216,attempt:1,durationMs:2000,textChars:350,reasoningChars:50,firstResponseMs:120,inputTokens:1000,outputTokens:100,reasoningTokens:20,updatedAt:"2026-01-01T00:00:02Z"};
    expect(parseFullProjectCheckpoint(encodeFullProjectCheckpoint(cp))?.lastRequest).toEqual(cp.lastRequest);
  });
  it("round trips plans, completed modules, in-flight batch and consumed budgets without clipping", () => {
    const cp = checkpoint();
    cp.message = "x".repeat(30_000);
    expect(parseFullProjectCheckpoint(encodeFullProjectCheckpoint(cp))).toEqual(cp);
  });
  it("rejects invalid or truncated checkpoints rather than resetting progress", () => {
    expect(parseFullProjectCheckpoint("FULL_PROJECT_CHECKPOINT\n{bad")).toBeNull();
    expect(parseFullProjectCheckpoint("FULL_PROJECT_CHECKPOINT\n{}")).toBeNull();
    expect(parseFullProjectCheckpoint("ordinary note")).toBeNull();
  });
  it("records interrupted time and unbounded statistics without enforcing budgets", () => {
    const cp = checkpoint();
    expect(consumedWallMs(cp, 4000)).toBe(3000);
    cp.modelCalls = 1_000_000;
    cp.nextStepIndex = 1_000_000;
    cp.elapsedMs = 1_000_000_000;
    cp.repairAttempts = 10_000;
    cp.maxSteps = 1_000_000;
    cp.maxModelCalls = 1_000_000;
    cp.maxWallMs = 1_000_000_000;
    cp.budgetExtensions = 10_000;
    expect(() => assertFullProjectBudget(cp, 1_000_000, 1_000_000, 4000)).not.toThrow();
    expect(parseFullProjectCheckpoint(encodeFullProjectCheckpoint(cp))).toEqual(cp);
  });
  it("has stable task/module/batch reconciliation keys across recovery", () => {
    expect(fullProjectBatchTitle("task", "business", 1)).toBe("FULL_PROJECT_BATCH:task:business:1");
    expect(fullProjectBatchTitle("other", "business", 1)).not.toBe(
      fullProjectBatchTitle("task", "business", 1),
    );
  });
});
describe("normalized failure progress safeguard", () => {
  it("ignores check timing, timestamps, ANSI styling, whitespace and order", () => {
    const report = (output: string, durationMs: number) => ({
      status: "failed" as const,
      checks: [{ id: "build", label: "build", status: "failed" as const, output, durationMs }],
    });
    expect(fullProjectAcceptanceFailureFingerprint(report("2026-01-01T00:00:00Z error TS2304 after 123ms", 1)))
      .toBe(fullProjectAcceptanceFailureFingerprint(report("2026-02-02T12:13:14Z  \u001b[31merror TS2304\u001b[0m after 987ms", 999)));
    expect(fullProjectAcceptanceFailureFingerprint(report("error TS2304", 1)))
      .not.toBe(fullProjectAcceptanceFailureFingerprint(report("error TS2305", 1)));
  });
});
describe("repairable acceptance classification", () => {
  const issue = (id: string, output: string) => ({
    id,
    output,
    status: "blocked" as const,
    label: id,
    durationMs: 0,
  });
  it("repairs known code/config blockers without relaxing checks", () => {
    expect(
      canRepairFullProjectAcceptance({
        status: "blocked",
        checks: [
          issue("frontend-test", "未声明 test 测试脚本，无法证明测试通过。"),
          issue("backend-verify", "未找到支持的 server/pom.xml 后端项目。"),
          issue("implementation-placeholders", "src/file: 后续将接入"),
        ],
      }),
    ).toBe(true);
  });
  it("never spends repair calls on tool, timeout, inspection, or unknown blockers", () => {
    for (const blocker of [
      issue("backend-verify", "缺少所需工具 mvn，无法执行检查。"),
      issue("inspection", "unsafe link"),
      issue("frontend-test", "工程检查已取消。"),
      issue("frontend-build", "unsupported stack"),
    ]) {
      expect(canRepairFullProjectAcceptance({ status: "blocked", checks: [blocker] })).toBe(false);
    }
  });
});
describe("full project complete scope planning", () => {
  it("topologically orders modules before generation", () => {
    const input = plan();
    input.modules.reverse();
    expect(orderFullProjectPlan(input, ["feature"]).modules.map((module) => module.kind)).toEqual([
      ...MODULE_KINDS,
    ]);
  });
  it("prioritizes business over deployment when dependencies permit", () => {
    const input = plan();
    input.modules.forEach((item) => {
      item.dependsOn = [];
    });
    input.modules.reverse();
    expect(orderFullProjectPlan(input, ["feature"]).modules.map((item) => item.kind)).toEqual([
      "foundation",
      "api",
      "business",
      "frontend",
      "tests",
      "config",
      "docs",
    ]);
  });
  it("requires real features and refuses missing or invented coverage", () => {
    expect(() => orderFullProjectPlan(plan(), [])).toThrow("已有");
    expect(() => orderFullProjectPlan(plan(), ["feature", "forgotten"])).toThrow("遗漏");
    expect(() => orderFullProjectPlan(plan(), ["another"])).toThrow("未知");
  });
  it("rejects cycles, duplicate IDs, and missing delivery kinds", () => {
    const cycle = plan();
    cycle.modules[0].dependsOn = ["docs"];
    expect(() => orderFullProjectPlan(cycle, ["feature"])).toThrow("循环");
    const duplicate = plan();
    duplicate.modules[0].id = "business";
    expect(() => orderFullProjectPlan(duplicate, ["feature"])).toThrow("重复");
    const missing = plan();
    missing.modules[6].kind = "config";
    expect(() => orderFullProjectPlan(missing, ["feature"])).toThrow("缺少");
  });
  it("accepts realistic large module plans without a count ceiling", () => {
    const large = plan();
    for (let index = 0; index < 100; index++)
      large.modules.push({ ...large.modules[1], id: `business-${index}`, dependsOn: ["foundation"] });
    expect(orderFullProjectPlan(large, ["feature"]).modules).toHaveLength(107);
  });
});
