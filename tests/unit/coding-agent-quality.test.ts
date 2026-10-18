import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), context: vi.fn() }));
vi.mock("@/server/ai/compat", () => ({ generateObjectCompat: mocks.generate }));
vi.mock("@/server/ai/provider", () => ({
  getChatModel: vi.fn(),
  AiNotConfiguredError: class extends Error {},
}));
vi.mock("@/server/agents/context", () => ({
  buildCodingContext: mocks.context,
  renderContextForPrompt: () => "context",
}));
import { generateImplementation, generatePlan } from "@/server/agents/coding-agent";

const input = { projectId: "project", userId: "user", message: "build real feature" };
const plan = {
  title: "实现功能",
  summary: "实现完整业务功能",
  risks: "",
  steps: [{ action: "modify" as const, path: "src/api.ts", reason: "接入数据库" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({});
});

describe("generation acceptance wiring without live AI", () => {
  it("preserves structured-output failures for safe batch recovery", async () => {
    const error = Object.assign(new Error("无完整JSON"), {
      name: "AiOutputFormatError",
      kind: "json",
    });
    mocks.generate.mockRejectedValue(error);
    await expect(generateImplementation({ ...input, plan })).rejects.toBe(error);
  });
  it("enforces coverage after model output", async () => {
    mocks.generate.mockResolvedValue({ notes: "done", changes: [] });
    await expect(generateImplementation({ ...input, plan })).rejects.toThrow("遗漏");
    expect(mocks.context).toHaveBeenCalledWith("project", "user", ["src/api.ts"], {
      requiredFullFilePaths: ["src/api.ts"],
    });
  });
  it("fails before model invocation when full rewrite context is unavailable", async () => {
    mocks.context.mockRejectedValue(new Error("禁止基于截断内容重写"));
    await expect(generateImplementation({ ...input, plan })).rejects.toThrow("截断");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("rejects unsafe confirmed plans before reading context or invoking the model", async () => {
    await expect(
      generateImplementation({
        ...input,
        plan: { ...plan, steps: [{ ...plan.steps[0], path: "../escape" }] },
      }),
    ).rejects.toThrow("不安全");
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("automatically selects planning context and checks returned plans", async () => {
    mocks.generate.mockResolvedValue({ ...plan, steps: [...plan.steps, plan.steps[0]] });
    await expect(generatePlan(input)).rejects.toThrow("重复");
    expect(mocks.context).toHaveBeenCalledWith("project", "user", undefined, {
      autoSelectPlanningFiles: true,
    });
  });
  it("does not start cancelled generation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(generatePlan({ ...input, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(
      generateImplementation({ ...input, plan, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("uses only external cancellation and rejects aborted model results", async () => {
    const controller = new AbortController();
    mocks.generate.mockImplementation(async (options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      expect(options.signal.aborted).toBe(true);
      return { notes: "done", changes: [{ ...plan.steps[0], content: "export const value = 1;" }] };
    });
    await expect(
      generateImplementation({ ...input, plan, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
