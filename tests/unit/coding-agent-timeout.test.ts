import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), context: vi.fn(), stream: vi.fn() }));
vi.mock("ai", () => ({ streamText: mocks.stream }));
vi.mock("@/server/ai/compat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/ai/compat")>()),
  generateObjectCompat: mocks.generate,
}));
vi.mock("@/server/ai/provider", () => ({
  getChatModel: vi.fn(),
  AiNotConfiguredError: class extends Error {},
}));
vi.mock("@/server/agents/context", () => ({
  buildCodingContext: mocks.context,
  renderContextForPrompt: () => "context",
}));
import { generateImplementation, generatePlan, streamChat } from "@/server/agents/coding-agent";
import { AiRequestTimeoutError } from "@/server/ai/compat";

const input = { projectId: "project", userId: "user", message: "task" };
const plan = {
  title: "计划",
  summary: "实现功能",
  risks: "",
  steps: [{ action: "modify" as const, path: "src/api.ts", reason: "接入数据库" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

it("does not add generation or chat deadlines or output caps", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  mocks.generate.mockResolvedValue(plan);
  await generatePlan(input);
  await streamChat(input);
  expect(timeout).not.toHaveBeenCalled();
  expect(mocks.generate.mock.calls[0][0]).not.toHaveProperty("maxOutputTokens");
  expect(mocks.stream.mock.calls[0][0]).not.toHaveProperty("maxOutputTokens");
  expect(mocks.stream.mock.calls[0][0].maxRetries).toBe(0);
});

it("forwards callbacks but ignores legacy planner output caps", async () => {
  const onRequestEvent = vi.fn();
  mocks.generate.mockResolvedValueOnce(plan).mockResolvedValueOnce({
    notes: "done",
    changes: [{ ...plan.steps[0], content: "export const value = 1;" }],
  });
  await generatePlan({ ...input, onRequestEvent });
  await generateImplementation({ ...input, plan, onRequestEvent, maxOutputTokens: 4_000 });
  expect(mocks.generate.mock.calls[0][0].onRequestEvent).toBe(onRequestEvent);
  expect(mocks.generate.mock.calls[1][0].onRequestEvent).toBe(onRequestEvent);
  expect(mocks.generate.mock.calls[1][0]).not.toHaveProperty("maxOutputTokens");
});

it("maps upstream timeout to typed Chinese error", async () => {
  mocks.generate.mockRejectedValue(new DOMException("upstream timeout", "TimeoutError"));
  await expect(generatePlan(input)).rejects.toBeInstanceOf(AiRequestTimeoutError);
});

it("preserves a custom parent cancellation reason instead of mapping timeout", async () => {
  const controller = new AbortController();
  const reason = new Error("user cancellation");
  mocks.generate.mockImplementation(async () => {
    controller.abort(reason);
    throw reason;
  });
  await expect(generatePlan({ ...input, signal: controller.signal })).rejects.toBe(reason);
});

it("preserves typed request timeout failures", async () => {
  const error = new AiRequestTimeoutError();
  mocks.generate.mockRejectedValue(error);
  await expect(generatePlan(input)).rejects.toBe(error);
});
