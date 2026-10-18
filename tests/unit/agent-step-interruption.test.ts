import { describe, it, expect } from "vitest";
import { effectiveAgentSteps, type AgentTaskDto } from "@/lib/agent";
const task = (status: string) =>
  ({
    status,
    steps: [
      { id: "old", index: 1, status: "running", detail: "" },
      { id: "new", index: 2, status: "running", detail: "" },
    ],
  }) as AgentTaskDto;
describe("interrupted step display", () => {
  it("shows only latest running attempt without mutating original records", () => {
    const t = task("planning");
    const rows = effectiveAgentSteps(t);
    expect(rows.map((s) => s.status)).toEqual(["failed", "running"]);
    expect(rows[0].detail).toContain("中断");
    expect(t.steps[0].status).toBe("running");
  });
  it.each(["failed", "cancelled", "paused", "completed"])(
    "never animates stale attempts for %s tasks",
    (status) => {
      expect(effectiveAgentSteps(task(status)).every((s) => s.status !== "running")).toBe(true);
    },
  );
});
