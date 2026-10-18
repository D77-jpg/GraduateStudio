import { describe, it, expect } from "vitest";
import { extendFullProjectBudget, isFullProjectBudgetExhausted } from "@/lib/full-project-budget";
import { assertFullProjectBudget, type FullProjectCheckpoint } from "@/lib/full-project";
const fixture = () =>
  ({
    phase: "blocked",
    activeSince: null,
    elapsedMs: 1_000_000_000,
    nextStepIndex: 1_000_000,
    maxSteps: 1,
    modelCalls: 1_000_000,
    maxWallMs: 1,
    maxModelCalls: 1,
    budgetExtensions: 10_000,
  }) as FullProjectCheckpoint;
describe("legacy budget compatibility without execution limits", () => {
  it("never treats accumulated work or legacy ceilings as exhausted", () => {
    const cp = fixture();
    expect(isFullProjectBudgetExhausted(cp)).toBe(false);
    expect(() => assertFullProjectBudget(cp, 1_000_000, 1_000_000)).not.toThrow();
  });
  it("extension returns the original checkpoint without changing statistics", () => {
    const cp = fixture();
    expect(extendFullProjectBudget(cp)).toBe(cp);
    expect(cp.budgetExtensions).toBe(10_000);
  });
  it("no-op compatibility handles live and terminal checkpoints too", () => {
    for (const phase of ["completed", "cancelled", "blocked"] as const) {
      const cp = { ...fixture(), phase, activeSince: Date.now() };
      expect(extendFullProjectBudget(cp)).toBe(cp);
      expect(isFullProjectBudgetExhausted(cp)).toBe(false);
    }
  });
});
