import { schema } from "@ai-career/db";

type MatchRow = typeof schema.jobMatches.$inferSelect;

export interface MatchFactors {
  skills: number | null;
  experience: number | null;
  location: number | null;
  sponsorship: number | null;
  role: number | null;
  salary: number | null;
  industry: number | null;
  freshness: number | null;
  semantic: number | null;
}

export interface MatchExplanationView {
  strongMatches: string[];
  partialMatches: string[];
  gaps: string[];
  summary: string;
}

export interface MatchView {
  matchId: string;
  eligible: boolean;
  ineligibleReason: string | null;
  /** 0-100, already weighted (computeOverallScore); null when ineligible. */
  overallScore: number | null;
  /** Each factor 0-100 (stored as a 0-1 fraction; converted here for the UI's percentage chips). */
  factors: MatchFactors | null;
  explanation: MatchExplanationView | null;
  userAction: "none" | "saved" | "dismissed";
  computedAt: string;
}

const pct = (value: string | null): number | null => (value === null ? null : Math.round(Number(value) * 100));

export function toMatchView(row: MatchRow): MatchView {
  return {
    matchId: row.id,
    eligible: row.eligible,
    ineligibleReason: row.ineligibleReason,
    overallScore: row.overallScore === null ? null : Number(row.overallScore),
    factors: row.eligible
      ? {
          skills: pct(row.skillsScore),
          experience: pct(row.experienceScore),
          location: pct(row.locationScore),
          sponsorship: pct(row.sponsorshipScore),
          role: pct(row.roleScore),
          salary: pct(row.salaryScore),
          industry: pct(row.industryScore),
          freshness: pct(row.freshnessScore),
          semantic: pct(row.semanticScore),
        }
      : null,
    explanation: row.eligible ? ((row.explanation as MatchExplanationView | null) ?? null) : null,
    userAction: row.userAction,
    computedAt: row.computedAt.toISOString(),
  };
}
