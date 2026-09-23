export interface SalaryComparisonInput {
  jobMin: number | null;
  jobMax: number | null;
  jobCurrency: string | null;
  jobIsParsed: boolean;
  floorNormalized: number | null;
  floorCurrency: string | null;
  floorIsParsed: boolean;
  targetNormalized: number | null;
  targetCurrency: string | null;
  targetIsParsed: boolean;
}

const sameCurrency = (a: string | null, b: string): boolean => a !== null && a.toUpperCase() === b.toUpperCase();

/**
 * Returns null ("unknown", weight redistributed by computeOverallScore) whenever there is nothing
 * safe to compare -- unparsed salary on either side, or a currency mismatch (D6: never estimate).
 * Below the floor is 0; at/above the target (or the floor alone, with no target stated) is 1;
 * in between interpolates linearly starting from 0.6 credit at the floor.
 */
export function scoreSalary(input: SalaryComparisonInput): number | null {
  if (!input.jobIsParsed || input.jobCurrency === null) return null;
  const jobFigure = input.jobMax ?? input.jobMin;
  if (jobFigure === null) return null;

  const floor = input.floorIsParsed && sameCurrency(input.floorCurrency, input.jobCurrency) ? input.floorNormalized : null;
  const target = input.targetIsParsed && sameCurrency(input.targetCurrency, input.jobCurrency) ? input.targetNormalized : null;
  if (floor === null && target === null) return null;

  if (floor !== null && jobFigure < floor) return 0;

  const benchmark = target ?? floor!;
  if (jobFigure >= benchmark) return 1;

  const base = floor ?? 0;
  const low = floor !== null ? 0.6 : 0;
  const span = benchmark - base || 1;
  return low + (1 - low) * ((jobFigure - base) / span);
}
