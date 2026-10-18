import { describe, it, expect } from "vitest";
import { agentTaskDtoSchema, AGENT_STEP_KIND_LABELS } from "@/lib/agent";
describe("durable diagnostic step DTO compatibility", () => {
  it("validates the whole task including persisted diagnostic records", () => {
    const step = {
      id: "step",
      index: 253,
      kind: "diagnostic",
      title: "依赖环境重新就绪",
      status: "done",
      detail: "记录",
      changeSetId: null,
      createdAt: "2026-01-01",
      finishedAt: null,
    };
    const task = {
      id: "task",
      projectId: "project",
      title: "任务",
      message: "需求",
      status: "checking",
      maxSteps: 240,
      fixAttempts: 9,
      error: null,
      gitCommitHash: null,
      createdAt: "2026-01-01",
      startedAt: null,
      finishedAt: null,
      steps: [step],
    };
    expect(agentTaskDtoSchema.parse(task).steps[0].kind).toBe("diagnostic");
    expect(AGENT_STEP_KIND_LABELS.diagnostic).toBe("诊断");
    expect(
      agentTaskDtoSchema.safeParse({ ...task, steps: [{ ...step, kind: "arbitrary" }] }).success,
    ).toBe(false);
  });
});
