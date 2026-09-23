const MS_PER_HOUR = 3_600_000;

/** Full credit under 24h (spec §9); exponential decay after that with a configurable half-life. Falls back to `firstSeenAt` when the source gave no posted date (labeled as such by the caller, matching Phase 4's own convention). */
export function scoreFreshness(postedAt: Date | null, firstSeenAt: Date, halfLifeHours: number, now: Date): number {
  const referenceDate = postedAt ?? firstSeenAt;
  const ageHours = Math.max(0, (now.getTime() - referenceDate.getTime()) / MS_PER_HOUR);
  if (ageHours <= 24) return 1;
  return Math.pow(0.5, ageHours / halfLifeHours);
}
