import type { FullProjectCheckpoint } from "./full-project";

/** Legacy compatibility: accumulated execution statistics are no longer budgets. */
export function isFullProjectBudgetExhausted(
  _cp: FullProjectCheckpoint,
  _now = Date.now(),
): boolean {
  void _cp;
  void _now;
  return false;
}

/** Legacy clients may still request an extension; preserve the checkpoint unchanged. */
export function extendFullProjectBudget(cp: FullProjectCheckpoint): FullProjectCheckpoint {
  return cp;
}
