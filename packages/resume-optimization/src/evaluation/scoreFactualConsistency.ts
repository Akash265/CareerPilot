/**
 * Pure arithmetic from applyDeterministicGuard's own tally (Task 6), not a separate LLM judgment
 * (design doc §7 decision 5) -- the guard already knows exactly which claims it accepted and
 * rejected, so this factor is a direct readout, not a re-derivation.
 */
export function scoreFactualConsistency(appliedCount: number, rejectedCount: number): number {
  const total = appliedCount + rejectedCount;
  if (total === 0) return 1;
  return appliedCount / total;
}
