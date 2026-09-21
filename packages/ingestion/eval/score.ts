import { extractMinExperience } from "../src/normalize/experience";
import { extractSalary } from "../src/normalize/salary";
import { extractSponsorship } from "../src/normalize/sponsorship";
import type { EvalCase } from "./cases";

export interface FieldScore {
  field: "salary" | "minExperience" | "sponsorship";
  cases: number;
  /** correct extractions */ tp: number;
  /** wrong or spurious extractions */ fp: number;
  /** missed or wrong extractions */ fn: number;
  /** correctly extracted nothing */ tn: number;
  precision: number;
  recall: number;
}

interface Tally {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/** expected/predicted use `null` for "nothing extracted". Wrong values count as BOTH a false positive and a false negative. */
function tally<T>(t: Tally, expected: T | null, predicted: T | null, equal: (a: T, b: T) => boolean): void {
  if (expected === null) {
    if (predicted === null) t.tn++;
    else t.fp++;
  } else if (predicted === null) {
    t.fn++;
  } else if (equal(expected, predicted)) {
    t.tp++;
  } else {
    t.fp++;
    t.fn++;
  }
}

const finish = (field: FieldScore["field"], cases: number, t: Tally): FieldScore => ({
  field,
  cases,
  ...t,
  precision: t.tp + t.fp === 0 ? 1 : t.tp / (t.tp + t.fp),
  recall: t.tp + t.fn === 0 ? 1 : t.tp / (t.tp + t.fn),
});

export function scoreExtraction(cases: EvalCase[]): FieldScore[] {
  const salary: Tally = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const experience: Tally = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const sponsorship: Tally = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const counts = { salary: 0, minExperience: 0, sponsorship: 0 };

  for (const c of cases) {
    if (c.salary !== undefined) {
      counts.salary++;
      const s = extractSalary(c.text);
      const predicted = s.isParsed ? { min: s.min!, max: s.max!, currency: s.currency!, period: s.period! } : null;
      tally(salary, c.salary, predicted, (a, b) => a.min === b.min && a.max === b.max && a.currency === b.currency && a.period === b.period);
    }
    if (c.minExperience !== undefined) {
      counts.minExperience++;
      tally(experience, c.minExperience, extractMinExperience(c.text).years, (a, b) => a === b);
    }
    if (c.sponsorship !== undefined) {
      counts.sponsorship++;
      const value = extractSponsorship(c.text).value;
      tally(sponsorship, c.sponsorship === "unknown" ? null : c.sponsorship, value === "unknown" ? null : value, (a, b) => a === b);
    }
  }
  return [
    finish("salary", counts.salary, salary),
    finish("minExperience", counts.minExperience, experience),
    finish("sponsorship", counts.sponsorship, sponsorship),
  ];
}
