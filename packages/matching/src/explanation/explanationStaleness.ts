const MS_PER_DAY = 86_400_000;

export interface StalenessInput {
  existing: { careerGoalId: string; explanationGeneratedAt: Date | null; explanationDescriptionHash: string | null } | undefined;
  activeCareerGoalId: string;
  currentDescriptionHash: string;
  now: Date;
  ttlDays: number;
}

/** design doc §7: content change or goal-version change invalidates immediately; otherwise a fixed TTL. */
export function isExplanationStale(input: StalenessInput): boolean {
  if (!input.existing || !input.existing.explanationGeneratedAt) return true;
  if (input.existing.careerGoalId !== input.activeCareerGoalId) return true;
  if (input.existing.explanationDescriptionHash !== input.currentDescriptionHash) return true;
  const ageDays = (input.now.getTime() - input.existing.explanationGeneratedAt.getTime()) / MS_PER_DAY;
  return ageDays > input.ttlDays;
}
