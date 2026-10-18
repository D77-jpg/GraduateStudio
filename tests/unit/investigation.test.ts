import { describe, expect, it, vi } from "vitest";
import { investigateAcceptanceFailure } from "@/server/agents/investigation";
import type { AcceptanceReport } from "@/lib/acceptance";
const report: AcceptanceReport = {
  version: 1,
  status: "failed",
  checks: [
    {
      id: "backend-test",
      label: "test",
      status: "failed",
      output: "AssertionError",
      durationMs: 1,
    },
  ],
  limitations: [],
};
function options() {
  return {
    projectDir: "fixture",
    report,
    focusId: "backend-test",
    signal: new AbortController().signal,
  };
}
describe("engineering investigation loop", () => {
  it("accepts a real reproduced failure alongside source evidence", async () => {
    const decide = vi
      .fn()
      .mockResolvedValueOnce({
        action: "tool",
        hypothesis: "read",
        request: { tool: "read_file", path: "backend/tests/app.test.js" },
      })
      .mockResolvedValueOnce({
        action: "tool",
        hypothesis: "reproduce",
        request: { tool: "node_test", directory: "backend", testPath: "tests/app.test.js" },
      })
      .mockResolvedValueOnce({
        action: "conclude",
        disposition: "repair",
        summary: "confirmed failure",
        evidenceIds: [0, 1],
        paths: [],
      });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: "assert" })
      .mockResolvedValueOnce({ ok: false, exitCode: 1, output: "AssertionError" });
    expect(
      (await investigateAcceptanceFailure({ ...options(), decide, execute })).disposition,
    ).toBe("repair");
  });
  it("observes source and feeds real evidence into a grounded conclusion", async () => {
    const decide = vi
      .fn()
      .mockResolvedValueOnce({
        action: "tool",
        hypothesis: "inspect teardown",
        request: { tool: "read_file", path: "backend/tests/app.test.js" },
      })
      .mockResolvedValueOnce({
        action: "conclude",
        disposition: "repair",
        summary: "after hook omits application closePool",
        evidenceIds: [0],
        paths: ["backend/tests/app.test.js"],
      });
    const execute = vi
      .fn()
      .mockResolvedValue({ ok: true, tool: "read_file", text: "after(closeHelper)" });
    const onObservation = vi.fn();
    const result = await investigateAcceptanceFailure({
      ...options(),
      decide,
      execute,
      onObservation,
    });
    expect(result.disposition).toBe("repair");
    expect(decide.mock.calls[1][0]).toContain("after(closeHelper)");
    expect(onObservation).toHaveBeenCalledTimes(1);
  });
  it("rejects fabricated evidence without mutating files", async () => {
    const decide = vi.fn().mockResolvedValue({
      action: "conclude",
      disposition: "repair",
      summary: "guessed fix",
      evidenceIds: [42],
      paths: [],
    });
    const execute = vi.fn();
    const result = await investigateAcceptanceFailure({ ...options(), decide, execute });
    expect(result.disposition).toBe("insufficient");
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not treat a denied tool as evidence for repair", async () => {
    const decide = vi
      .fn()
      .mockResolvedValueOnce({
        action: "tool",
        hypothesis: "inspect",
        request: { tool: "read_file", path: ".env" },
      })
      .mockResolvedValueOnce({
        action: "conclude",
        disposition: "repair",
        summary: "incorrect",
        evidenceIds: [0],
        paths: [],
      });
    const result = await investigateAcceptanceFailure({
      ...options(),
      decide,
      execute: vi.fn().mockResolvedValue({ ok: false, blockedReason: "secret" }),
    });
    expect(result.disposition).toBe("insufficient");
  });
  it("stops identical requests instead of running a tool repeatedly", async () => {
    const decide = vi.fn().mockResolvedValue({
      action: "tool",
      hypothesis: "inspect",
      request: { tool: "list_files", directory: "backend" },
    });
    const execute = vi.fn().mockResolvedValue({ ok: true, files: [] });
    const result = await investigateAcceptanceFailure({ ...options(), decide, execute });
    expect(result.disposition).toBe("insufficient");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("requires source reading before code repair even if a test was executed", async () => {
    const decide = vi
      .fn()
      .mockResolvedValueOnce({
        action: "tool",
        hypothesis: "reproduce",
        request: { tool: "node_test", directory: "backend", testPath: "tests/app.test.js" },
      })
      .mockResolvedValueOnce({
        action: "conclude",
        disposition: "repair",
        summary: "guess",
        evidenceIds: [0],
        paths: [],
      });
    const result = await investigateAcceptanceFailure({
      ...options(),
      decide,
      execute: vi.fn().mockResolvedValue({ ok: true, exitCode: 1 }),
    });
    expect(result.disposition).toBe("insufficient");
  });
  it("honors cancellation before model/tool calls", async () => {
    const c = new AbortController();
    c.abort();
    const decide = vi.fn();
    await expect(
      investigateAcceptanceFailure({ ...options(), signal: c.signal, decide }),
    ).rejects.toThrow();
    expect(decide).not.toHaveBeenCalled();
  });
});
