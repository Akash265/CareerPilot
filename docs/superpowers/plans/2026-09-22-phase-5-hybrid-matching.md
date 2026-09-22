# Phase 5 — Hybrid Matching Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic-eligibility + hybrid-retrieval + weighted-scoring + AI-explanation matching engine that turns a confirmed career goal and the Phase 4 job catalog into a ranked, explainable `/matches` list.

**Architecture:** A new pure/testable `@ai-career/matching` package (eligibility rules, factor scoring math, retrieval SQL, explanation prompt) orchestrated by a `runMatching` pipeline function, run by a new `services/matching-worker` BullMQ worker (mirrors `services/job-ingestion`) enqueued from a new `POST /api/matches/run` route. Results land in a new `job_matches` table read by `GET /api/matches` and a new `/matches` page.

**Tech Stack:** TypeScript, Drizzle ORM + pgvector (`<=>` cosine distance), BullMQ/Redis, Anthropic SDK (fast tier, tool-use), Voyage embeddings (existing `@ai-career/ai` wrapper), Next.js route handlers, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-22-phase-5-hybrid-matching-design.md`

## Global Constraints

- All new tables carry `user_id UUID` defaulting to `current_setting('app.current_user_id')::uuid`, with RLS enabled via a `user_isolation` policy (D2) — every query goes through `withUserContext`.
- The LLM never computes or estimates a numeric score, a salary figure, or eligibility — it only narrates already-computed deterministic factor scores into prose (D6's boundary, spec §6/§7 in the design doc).
- No job description text (or resume text) is ever put in an explanation prompt — only pre-computed scores and short evidence strings (design doc §9's security note).
- Logs carry error classes, ids and counts only — never job content, profile content, or explanation text (CLAUDE.md §9).
- Domain logic lives in `packages/matching` (pure, unit-testable); `services/matching-worker` is BullMQ glue only (D32's precedent).
- No structured job-requirement extraction table and no LLM call to extract a job's skill list — skill matching reads `jobs.descriptionText` directly (design doc §1's scope boundary; requirement extraction is Phase 6).
- Model version is resolved by role via `env.ANTHROPIC_MODEL_FAST`, never hardcoded (D7).
- Every derived/ineligible signal carries an evidence string, never a bare boolean or opaque number (CLAUDE.md §6).

## Refinements to the spec (decided during planning)

| # | Refinement | Why |
|---|---|---|
| 1 | `job_matches` gains `explanation_description_hash text` (not in the design doc's §3 table) | Section 7's staleness rule ("the job's descriptionHash changed since `explanation_generated_at`") needs somewhere to record which hash the stored explanation was generated against; comparing against the job's *current* hash alone can't detect "changed since". |
| 2 | `skillsScore` and `semanticScore` both read from the same underlying job↔goal cosine similarity | Architecture.md's weight table describes `skillsScore` as "Exact + semantic alignment" and `semanticScore` as "Overall contextual fit" — two different uses of one embedding pair, not two embeddings. `skillsScore` blends it 30/70 with the literal keyword hit rate; `semanticScore` uses it directly. |
| 3 | `excludedIndustries`/`preferredIndustries` are matched by case-insensitive substring against `companyName` only (never `descriptionText`) | No structured `industry` field exists on `jobs` (design doc §5/§6/§10 already call this a known weak signal); matching against the company name only avoids the false-positive noise of scanning free text for common industry words. |
| 4 | `job_matches.user_action` and `user_action_at` are always carried forward from the prior row on every upsert, for both eligible and ineligible outcomes | A dismiss must survive the next recompute (design doc §5's "Previously dismissed" eligibility rule reads the *previous* row before the new one is written). |

## File Structure

```
packages/matching/                          # NEW package
  src/
    types.ts                                 # FactorScores, EligibilityResult, weights
    eligibility/evaluateEligibility.ts
    scoring/scoreSkills.ts
    scoring/scoreExperience.ts
    scoring/scoreLocation.ts
    scoring/scoreSponsorship.ts
    scoring/scoreRole.ts
    scoring/scoreSalary.ts
    scoring/scoreIndustry.ts
    scoring/scoreFreshness.ts
    scoring/scoreSemantic.ts
    scoring/computeOverallScore.ts
    embeddings/ensureGoalEmbedding.ts
    embeddings/ensureJobEmbeddings.ts
    embeddings/vectorLiteral.ts
    retrieval/fetchCandidateJobs.ts
    explanation/matchExplanationSchema.ts
    explanation/generateMatchExplanation.ts
    explanation/explanationStaleness.ts
    pipeline/upsertMatch.ts
    pipeline/runMatching.ts
    queue.ts                                 # queue name/job-name/id constants (no bullmq dep, mirrors ingestion/queue.ts)
    testing/db.ts                            # test DB helpers (mirrors ingestion/testing/db.ts)
    testing/factories.ts
    index.ts
  eval/
    match-explanation-fixtures/*.json
    scoreExplanationEval.ts
  package.json, tsconfig.json, vitest.config.ts, eslint.config.mjs

packages/db/src/schema/
  jobs.ts                                    # MODIFY: + embedding, embeddingContentHash, embeddingModel
  careerGoalConstraints.ts                   # MODIFY: + embedding, embeddingModel
  jobMatches.ts                              # NEW
  matchingRuns.ts                            # NEW
  index.ts                                   # MODIFY: + new exports
migrations/00XX_...sql                       # NEW: generated + one custom RLS/index migration

services/matching-worker/                    # NEW service
  src/worker.ts
  src/main.ts
  package.json, tsconfig.json, vitest.config.ts, eslint.config.mjs

apps/web/src/
  lib/matching/enqueue.ts                    # NEW
  lib/matching/serializeMatch.ts             # NEW
  lib/matching/listMatches.ts                # NEW
  lib/matching/matchActionSchema.ts          # NEW
  lib/career-goal/saveCareerGoal.ts          # MODIFY: generate goal embedding on confirm
  app/api/matches/run/route.ts               # NEW
  app/api/matches/route.ts                   # NEW
  app/api/matches/[jobId]/route.ts           # NEW
  app/api/matches/runs/latest/route.ts       # NEW
  app/matches/page.tsx                       # NEW
  app/matches/MatchesClient.tsx              # NEW
  app/matches/MatchRow.tsx                   # NEW
  app/matches/[jobId]/page.tsx               # NEW
  app/page.tsx                               # MODIFY: + nav link

packages/config/src/env.ts                   # MODIFY: + MATCHING_* env vars
.env.example                                 # MODIFY
```

---

### Task 1: `@ai-career/matching` package scaffold, domain types, eligibility rules

**Files:**
- Create: `packages/matching/package.json`, `packages/matching/tsconfig.json`, `packages/matching/vitest.config.ts`, `packages/matching/eslint.config.mjs`
- Create: `packages/matching/src/types.ts`
- Create: `packages/matching/src/eligibility/evaluateEligibility.ts`
- Test: `packages/matching/src/eligibility/evaluateEligibility.test.ts`

**Interfaces:**
- Produces: `FactorScores`, `WorkMode`, `WorkModePreference`, `Sponsorship` types (used by every scoring task); `EligibilityInput`, `EligibilityResult`, `evaluateEligibility(input): EligibilityResult` (used by Task 8's pipeline).

- [ ] **Step 1: Scaffold the package**

`packages/matching/package.json`:
```json
{
  "name": "@ai-career/matching",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src eval",
    "eval:explanation": "dotenv -e ../../.env -- tsx eval/scoreExplanationEval.ts"
  },
  "dependencies": {
    "@ai-career/ai": "workspace:*",
    "@ai-career/config": "workspace:*",
    "@ai-career/db": "workspace:*",
    "@anthropic-ai/sdk": "^0.32.1",
    "drizzle-orm": "^0.36.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "dotenv-cli": "^7.4.0",
    "eslint": "^9.0.0",
    "postgres": "^3.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/matching/tsconfig.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "eval"]
}
```

`packages/matching/vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests (Task 6+) migrate the shared test database, same reason as packages/ingestion.
    fileParallelism: false,
  },
});
```

`packages/matching/eslint.config.mjs`:
```javascript
import baseConfig from "../../eslint.config.base.mjs";

export default baseConfig;
```

- [ ] **Step 2: Add the workspace member and install**

Run: `pnpm install`
Expected: `@ai-career/matching` appears in the workspace (pnpm reads `pnpm-workspace.yaml`'s existing `packages/*` glob, no change needed there).

- [ ] **Step 3: Write domain types**

`packages/matching/src/types.ts`:
```typescript
export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";
export type WorkModePreference = "remote" | "hybrid" | "onsite" | "any";
export type Sponsorship = "offered" | "not_offered" | "unknown";

/**
 * Every factor is a 0-1 fraction except `salaryScore`, which is `null` when
 * there is nothing safe to compare (missing/unparsed salary data, or a
 * currency mismatch) -- D6: never estimate. `computeOverallScore` (Task 2)
 * redistributes a null factor's weight across the rest rather than treating
 * it as zero.
 */
export interface FactorScores {
  skillsScore: number;
  experienceScore: number;
  locationScore: number;
  sponsorshipScore: number;
  roleScore: number;
  salaryScore: number | null;
  industryScore: number;
  freshnessScore: number;
  semanticScore: number;
}

/** architecture.md §4's initial weights (skills 30/experience 15/location 15/sponsorship 10/role 10/salary 5/industry 5/freshness 5/semantic 5). */
export const FACTOR_WEIGHTS: Record<keyof FactorScores, number> = {
  skillsScore: 0.3,
  experienceScore: 0.15,
  locationScore: 0.15,
  sponsorshipScore: 0.1,
  roleScore: 0.1,
  salaryScore: 0.05,
  industryScore: 0.05,
  freshnessScore: 0.05,
  semanticScore: 0.05,
};
```

- [ ] **Step 4: Write the failing eligibility test**

`packages/matching/src/eligibility/evaluateEligibility.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { evaluateEligibility, type EligibilityInput } from "./evaluateEligibility";

const base: EligibilityInput = {
  companyName: "Acme Corp",
  jobWorkMode: "remote",
  jobMinExperienceYears: null,
  jobSponsorship: "unknown",
  excludedCompanies: [],
  excludedIndustries: [],
  constraintsWorkMode: "any",
  visaSponsorshipRequired: null,
  candidateYearsOfExperience: 5,
  experienceGraceYears: 1,
  previouslyDismissed: false,
};

describe("evaluateEligibility", () => {
  it("is eligible when nothing disqualifies it", () => {
    expect(evaluateEligibility(base)).toEqual({ eligible: true, reason: null });
  });

  it("excludes a company on the excluded-companies list, case-insensitively", () => {
    const result = evaluateEligibility({ ...base, excludedCompanies: ["acme"] });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/Acme Corp.*excluded-companies/);
  });

  it("excludes a company whose name contains an excluded-industry term", () => {
    const result = evaluateEligibility({ ...base, companyName: "Acme Defense Systems", excludedIndustries: ["defense"] });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/excluded industry.*defense/i);
  });

  it("excludes an onsite job when the goal requires remote", () => {
    const result = evaluateEligibility({ ...base, jobWorkMode: "onsite", constraintsWorkMode: "remote" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/onsite.*remote/i);
  });

  it("excludes a hybrid job when the goal requires remote", () => {
    const result = evaluateEligibility({ ...base, jobWorkMode: "hybrid", constraintsWorkMode: "remote" });
    expect(result.eligible).toBe(false);
  });

  it("does not exclude a remote job when the goal requires remote", () => {
    expect(evaluateEligibility({ ...base, jobWorkMode: "remote", constraintsWorkMode: "remote" }).eligible).toBe(true);
  });

  it("does not exclude an onsite job when work mode preference is 'any'", () => {
    expect(evaluateEligibility({ ...base, jobWorkMode: "onsite", constraintsWorkMode: "any" }).eligible).toBe(true);
  });

  it("excludes a job requiring more than experience + grace years", () => {
    const result = evaluateEligibility({
      ...base, jobMinExperienceYears: 7, candidateYearsOfExperience: 5, experienceGraceYears: 1,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/7\+? years.*5/);
  });

  it("does not exclude a job within the experience grace window", () => {
    const result = evaluateEligibility({
      ...base, jobMinExperienceYears: 6, candidateYearsOfExperience: 5, experienceGraceYears: 1,
    });
    expect(result.eligible).toBe(true);
  });

  it("never hard-blocks on experience when either side is unknown", () => {
    expect(evaluateEligibility({ ...base, jobMinExperienceYears: 20, candidateYearsOfExperience: null }).eligible).toBe(true);
    expect(evaluateEligibility({ ...base, jobMinExperienceYears: null, candidateYearsOfExperience: 0 }).eligible).toBe(true);
  });

  it("excludes a job that does not offer sponsorship when it is required", () => {
    const result = evaluateEligibility({ ...base, visaSponsorshipRequired: true, jobSponsorship: "not_offered" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/sponsorship/i);
  });

  it("does not exclude an unknown-sponsorship job even when sponsorship is required", () => {
    expect(evaluateEligibility({ ...base, visaSponsorshipRequired: true, jobSponsorship: "unknown" }).eligible).toBe(true);
  });

  it("excludes a previously dismissed job regardless of every other field", () => {
    const result = evaluateEligibility({ ...base, previouslyDismissed: true });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/dismissed/i);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @ai-career/matching test`
Expected: FAIL — `evaluateEligibility.ts` does not exist yet.

- [ ] **Step 6: Implement `evaluateEligibility`**

`packages/matching/src/eligibility/evaluateEligibility.ts`:
```typescript
import type { Sponsorship, WorkMode, WorkModePreference } from "../types";

export interface EligibilityInput {
  companyName: string;
  jobWorkMode: WorkMode;
  jobMinExperienceYears: number | null;
  jobSponsorship: Sponsorship;
  excludedCompanies: string[];
  excludedIndustries: string[];
  constraintsWorkMode: WorkModePreference;
  visaSponsorshipRequired: boolean | null;
  candidateYearsOfExperience: number | null;
  experienceGraceYears: number;
  previouslyDismissed: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  /** A fixed, evidence-carrying string when ineligible; null when eligible. Never a bare boolean (CLAUDE.md §6). */
  reason: string | null;
}

const ELIGIBLE: EligibilityResult = { eligible: true, reason: null };

/**
 * Deterministic hard filter (design doc §5). Order matters only for which single reason is
 * reported when several would apply; "previously dismissed" is checked first since it reflects
 * an explicit user decision that should never be second-guessed by any other rule.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  if (input.previouslyDismissed) {
    return { eligible: false, reason: "You dismissed this job." };
  }

  const nameLower = input.companyName.toLowerCase();

  const excludedCompany = input.excludedCompanies.find((c) => nameLower.includes(c.toLowerCase()));
  if (excludedCompany) {
    return { eligible: false, reason: `${input.companyName} matches "${excludedCompany}" on your excluded-companies list.` };
  }

  const excludedIndustry = input.excludedIndustries.find((term) => nameLower.includes(term.toLowerCase()));
  if (excludedIndustry) {
    return { eligible: false, reason: `${input.companyName} matches your excluded industry "${excludedIndustry}".` };
  }

  if (input.constraintsWorkMode === "remote" && (input.jobWorkMode === "onsite" || input.jobWorkMode === "hybrid")) {
    return { eligible: false, reason: `This role is ${input.jobWorkMode}, but your career goal requires remote.` };
  }

  if (
    input.jobMinExperienceYears !== null &&
    input.candidateYearsOfExperience !== null &&
    input.jobMinExperienceYears > input.candidateYearsOfExperience + input.experienceGraceYears
  ) {
    return {
      eligible: false,
      reason: `Requires ${input.jobMinExperienceYears}+ years; your profile states ${input.candidateYearsOfExperience}.`,
    };
  }

  if (input.visaSponsorshipRequired === true && input.jobSponsorship === "not_offered") {
    return { eligible: false, reason: "Your career goal requires visa sponsorship, and this posting states it does not offer it." };
  }

  return ELIGIBLE;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @ai-career/matching test`
Expected: PASS — all 13 cases green.

- [ ] **Step 8: Commit**

```bash
git add packages/matching/package.json packages/matching/tsconfig.json packages/matching/vitest.config.ts \
        packages/matching/eslint.config.mjs packages/matching/src/types.ts \
        packages/matching/src/eligibility pnpm-lock.yaml
git commit -m "feat(matching): scaffold @ai-career/matching, domain types, deterministic eligibility filter"
```

### Task 2: Deterministic factor scoring functions + weighted overall score

**Files:**
- Create: `packages/matching/src/scoring/scoreSkills.ts`, `scoreExperience.ts`, `scoreLocation.ts`, `scoreSponsorship.ts`, `scoreRole.ts`, `scoreSalary.ts`, `scoreIndustry.ts`, `scoreFreshness.ts`, `scoreSemantic.ts`, `computeOverallScore.ts`
- Test: one `.test.ts` per file above

**Interfaces:**
- Consumes: `FactorScores`, `FACTOR_WEIGHTS` from `packages/matching/src/types.ts` (Task 1).
- Produces: `scoreSkills`, `scoreExperience`, `scoreLocation`, `scoreSponsorship`, `scoreRole`, `scoreSalary`, `scoreIndustry`, `scoreFreshness`, `scoreSemantic`, `computeOverallScore` — all pure functions consumed by Task 8's pipeline.

- [ ] **Step 1: Write the failing tests (all nine factors + the combiner)**

`packages/matching/src/scoring/scoreSkills.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { scoreSkills } from "./scoreSkills";

describe("scoreSkills", () => {
  it("gives full credit when no skills are stated", () => {
    const result = scoreSkills([], "Senior Engineer", "We use Python and SQL.", 0.9);
    expect(result.score).toBe(1);
    expect(result.matches).toEqual([]);
  });

  it("finds a skill mentioned in the title or description, case-insensitively", () => {
    const result = scoreSkills(["Python", "Tableau"], "Data Engineer", "5 years of python required.", null);
    expect(result.matches).toEqual([
      { skill: "Python", found: true },
      { skill: "Tableau", found: false },
    ]);
    expect(result.lexicalHitRate).toBeCloseTo(0.5);
  });

  it("blends lexical hit rate 70/30 with semantic similarity when both are known", () => {
    const result = scoreSkills(["Python"], "Engineer", "python required", 0.4);
    // lexicalHitRate = 1 (found), semantic = 0.4 -> 0.7*1 + 0.3*0.4 = 0.82
    expect(result.score).toBeCloseTo(0.82);
  });

  it("falls back to pure lexical hit rate when semantic similarity is unavailable", () => {
    const result = scoreSkills(["Python", "SQL"], "Engineer", "python only", null);
    expect(result.score).toBeCloseTo(0.5);
  });

  it("clamps the score to [0, 1]", () => {
    const result = scoreSkills(["Python"], "Engineer", "python required", 1);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
```

`packages/matching/src/scoring/scoreExperience.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { scoreExperience } from "./scoreExperience";

describe("scoreExperience", () => {
  it("gives full credit when the job states no minimum", () => {
    expect(scoreExperience(null, 3, 1)).toBe(1);
  });
  it("gives full credit when the candidate's years are unknown", () => {
    expect(scoreExperience(5, null, 1)).toBe(1);
  });
  it("gives full credit when the candidate meets or exceeds the minimum", () => {
    expect(scoreExperience(5, 5, 1)).toBe(1);
    expect(scoreExperience(5, 8, 1)).toBe(1);
  });
  it("degrades linearly within the grace window", () => {
    // gap 1 of grace 2 -> 1 - 1/2 = 0.5
    expect(scoreExperience(6, 5, 2)).toBeCloseTo(0.5);
  });
  it("never goes below zero beyond the grace window", () => {
    expect(scoreExperience(20, 5, 1)).toBe(0);
  });
});
```

`packages/matching/src/scoring/scoreLocation.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { scoreLocation } from "./scoreLocation";

describe("scoreLocation", () => {
  it("gives full credit whenever the goal has no work-mode preference", () => {
    expect(scoreLocation("onsite", "any", "Paris", null, [])).toBe(1);
  });
  it("gives full credit for an exact work-mode match", () => {
    expect(scoreLocation("hybrid", "hybrid", "Berlin", null, [])).toBe(1);
  });
  it("gives partial credit for an unknown job work mode", () => {
    expect(scoreLocation("unknown", "remote", null, null, [])).toBe(0.5);
  });
  it("gives more credit for a location overlap than none, on a work-mode mismatch", () => {
    const overlap = scoreLocation("hybrid", "onsite", "Berlin, Germany", "DE", ["Germany"]);
    const noOverlap = scoreLocation("hybrid", "onsite", "Austin, TX", "US", ["Germany"]);
    expect(overlap).toBeGreaterThan(noOverlap);
  });
  it("gives mild credit on a work-mode mismatch when the goal states no target locations", () => {
    expect(scoreLocation("hybrid", "onsite", "Austin, TX", "US", [])).toBe(0.6);
  });
});
```

`packages/matching/src/scoring/scoreSponsorship.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { scoreSponsorship } from "./scoreSponsorship";

describe("scoreSponsorship", () => {
  it("gives full credit when sponsorship is not required", () => {
    expect(scoreSponsorship(false, "not_offered")).toBe(1);
    expect(scoreSponsorship(null, "not_offered")).toBe(1);
  });
  it("gives full credit when required and offered", () => {
    expect(scoreSponsorship(true, "offered")).toBe(1);
  });
  it("gives partial credit when required and unknown", () => {
    expect(scoreSponsorship(true, "unknown")).toBe(0.5);
  });
  it("gives zero when required and explicitly not offered", () => {
    expect(scoreSponsorship(true, "not_offered")).toBe(0);
  });
});
```

`packages/matching/src/scoring/scoreRole.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { scoreRole } from "./scoreRole";

describe("scoreRole", () => {
  it("gives full credit when no target roles are stated", () => {
    expect(scoreRole([], "Data Engineer")).toBe(1);
  });
  it("gives full credit for a title containing every word of the target role", () => {
    expect(scoreRole(["Data Engineer"], "Senior Data Engineer")).toBe(1);
  });
  it("gives partial credit for a partial word overlap", () => {
    const score = scoreRole(["Data Engineer"], "Data Analyst");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
  it("gives a low score for no word overlap", () => {
    expect(scoreRole(["Data Engineer"], "Marketing Manager")).toBe(0);
  });
});
```

`packages/matching/src/scoring/scoreSalary.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { scoreSalary, type SalaryComparisonInput } from "./scoreSalary";

const base: SalaryComparisonInput = {
  jobMin: 70000, jobMax: 90000, jobCurrency: "USD", jobIsParsed: true,
  floorNormalized: null, floorCurrency: null, floorIsParsed: false,
  targetNormalized: null, targetCurrency: null, targetIsParsed: false,
};

describe("scoreSalary", () => {
  it("returns null when the job's salary is not parsed", () => {
    expect(scoreSalary({ ...base, jobIsParsed: false })).toBeNull();
  });
  it("returns null when neither a floor nor a target is parsed", () => {
    expect(scoreSalary(base)).toBeNull();
  });
  it("returns null on a currency mismatch", () => {
    const result = scoreSalary({ ...base, floorNormalized: 60000, floorCurrency: "EUR", floorIsParsed: true });
    expect(result).toBeNull();
  });
  it("returns 0 when below a parsed floor", () => {
    const result = scoreSalary({ ...base, jobMax: 50000, jobMin: 40000, floorNormalized: 60000, floorCurrency: "USD", floorIsParsed: true });
    expect(result).toBe(0);
  });
  it("returns 1 when at or above the target", () => {
    const result = scoreSalary({ ...base, targetNormalized: 90000, targetCurrency: "USD", targetIsParsed: true });
    expect(result).toBe(1);
  });
  it("returns 1 when at or above the floor and no target is stated", () => {
    const result = scoreSalary({ ...base, floorNormalized: 70000, floorCurrency: "USD", floorIsParsed: true });
    expect(result).toBe(1);
  });
  it("interpolates between the floor and target", () => {
    // jobFigure 90000, floor 70000, target 110000 -> 0.6 + 0.4*(20000/40000) = 0.8
    const result = scoreSalary({
      ...base, floorNormalized: 70000, floorCurrency: "USD", floorIsParsed: true,
      targetNormalized: 110000, targetCurrency: "USD", targetIsParsed: true,
    });
    expect(result).toBeCloseTo(0.8);
  });
});
```

`packages/matching/src/scoring/scoreIndustry.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { scoreIndustry } from "./scoreIndustry";

describe("scoreIndustry", () => {
  it("gives full credit when no preferred industries are stated", () => {
    expect(scoreIndustry("Acme Corp", [])).toBe(1);
  });
  it("gives full credit for a company-name match", () => {
    expect(scoreIndustry("Acme Fintech Inc", ["fintech"])).toBe(1);
  });
  it("gives partial credit for no match, never zero", () => {
    expect(scoreIndustry("Acme Logistics", ["fintech"])).toBe(0.5);
  });
});
```

`packages/matching/src/scoring/scoreFreshness.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { scoreFreshness } from "./scoreFreshness";

describe("scoreFreshness", () => {
  const now = new Date("2026-09-22T00:00:00Z");

  it("gives full credit under 24 hours old", () => {
    const postedAt = new Date("2026-09-21T06:00:00Z");
    expect(scoreFreshness(postedAt, postedAt, 168, now)).toBe(1);
  });
  it("decays with age past 24 hours, halving every half-life", () => {
    const postedAt = new Date("2026-09-15T00:00:00Z"); // 168h = one half-life before `now`
    expect(scoreFreshness(postedAt, postedAt, 168, now)).toBeCloseTo(0.5, 2);
  });
  it("falls back to firstSeenAt when postedAt is null", () => {
    const firstSeenAt = new Date("2026-09-21T06:00:00Z");
    expect(scoreFreshness(null, firstSeenAt, 168, now)).toBe(1);
  });
});
```

`packages/matching/src/scoring/scoreSemantic.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { scoreSemantic } from "./scoreSemantic";

describe("scoreSemantic", () => {
  it("passes a known similarity through unchanged", () => {
    expect(scoreSemantic(0.73)).toBe(0.73);
  });
  it("is neutral, never zero, when similarity is unknown", () => {
    expect(scoreSemantic(null)).toBe(0.5);
  });
});
```

`packages/matching/src/scoring/computeOverallScore.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { computeOverallScore } from "./computeOverallScore";
import type { FactorScores } from "../types";

const allOnes: FactorScores = {
  skillsScore: 1, experienceScore: 1, locationScore: 1, sponsorshipScore: 1,
  roleScore: 1, salaryScore: 1, industryScore: 1, freshnessScore: 1, semanticScore: 1,
};

describe("computeOverallScore", () => {
  it("returns 100 when every factor is a perfect 1", () => {
    expect(computeOverallScore(allOnes)).toBe(100);
  });
  it("returns 0 when every factor is 0 (salaryScore included)", () => {
    const allZero: FactorScores = { ...allOnes, salaryScore: 0, skillsScore: 0, experienceScore: 0, locationScore: 0, sponsorshipScore: 0, roleScore: 0, industryScore: 0, freshnessScore: 0, semanticScore: 0 };
    expect(computeOverallScore(allZero)).toBe(0);
  });
  it("redistributes a null salaryScore's weight across the other factors instead of zeroing it", () => {
    const withNullSalary: FactorScores = { ...allOnes, salaryScore: null };
    // Every other factor is still 1, so the weighted average of the known factors is still 1 -> 100,
    // not 95 (which is what treating null as 0 would give).
    expect(computeOverallScore(withNullSalary)).toBe(100);
  });
  it("weights skills (30%) more than freshness (5%)", () => {
    const weakSkills: FactorScores = { ...allOnes, skillsScore: 0 };
    const weakFreshness: FactorScores = { ...allOnes, freshnessScore: 0 };
    expect(computeOverallScore(weakSkills)).toBeLessThan(computeOverallScore(weakFreshness));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ai-career/matching test`
Expected: FAIL — none of the scoring modules exist yet.

- [ ] **Step 3: Implement each factor**

`packages/matching/src/scoring/scoreSkills.ts`:
```typescript
export interface SkillMatchDetail {
  skill: string;
  found: boolean;
}

export interface SkillsScoreResult {
  score: number;
  lexicalHitRate: number;
  matches: SkillMatchDetail[];
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Deterministic keyword hit-rate blended 70/30 with job<->goal semantic similarity (Refinement #2:
 * the same signal `scoreSemantic` uses on its own for "overall contextual fit"). A skill is "found"
 * on a plain case-insensitive substring match against the title + description -- deliberately not a
 * regex, so skill names with regex metacharacters ("C++", "C#") never need escaping.
 */
export function scoreSkills(
  skills: string[],
  jobTitle: string,
  descriptionText: string,
  semanticSimilarity: number | null
): SkillsScoreResult {
  if (skills.length === 0) {
    return { score: 1, lexicalHitRate: 1, matches: [] };
  }
  const haystack = `${jobTitle} ${descriptionText}`.toLowerCase();
  const matches = skills.map((skill) => ({ skill, found: haystack.includes(skill.toLowerCase()) }));
  const lexicalHitRate = matches.filter((m) => m.found).length / matches.length;
  const score =
    semanticSimilarity === null ? lexicalHitRate : clamp01(0.7 * lexicalHitRate + 0.3 * semanticSimilarity);
  return { score: clamp01(score), lexicalHitRate, matches };
}
```

`packages/matching/src/scoring/scoreExperience.ts`:
```typescript
/**
 * Full credit when either side is unknown or the candidate already meets the minimum (never guess,
 * never penalize missing data -- CLAUDE.md §6). A gap beyond `graceYears` is only reachable here in
 * a unit test: `evaluateEligibility` (Task 1) already hard-excludes it before scoring runs.
 */
export function scoreExperience(
  jobMinYears: number | null,
  candidateYears: number | null,
  graceYears: number
): number {
  if (jobMinYears === null || candidateYears === null) return 1;
  if (jobMinYears <= candidateYears) return 1;
  const gap = jobMinYears - candidateYears;
  return Math.max(0, 1 - gap / graceYears);
}
```

`packages/matching/src/scoring/scoreLocation.ts`:
```typescript
import type { WorkMode, WorkModePreference } from "../types";

/**
 * The hard remote-vs-onsite/hybrid mismatch is already excluded before scoring (Task 1); everything
 * reaching this function is a *softer* signal about work mode and geography.
 */
export function scoreLocation(
  jobWorkMode: WorkMode,
  constraintsWorkMode: WorkModePreference,
  jobLocationRaw: string | null,
  jobCountryCode: string | null,
  goalLocations: string[]
): number {
  if (constraintsWorkMode === "any") return 1;
  if (jobWorkMode === constraintsWorkMode) return 1;
  if (jobWorkMode === "unknown") return 0.5;

  if (goalLocations.length === 0) return 0.6;
  const haystack = `${jobLocationRaw ?? ""} ${jobCountryCode ?? ""}`.toLowerCase();
  const overlaps = goalLocations.some((loc) => haystack.includes(loc.toLowerCase()));
  return overlaps ? 0.7 : 0.3;
}
```

`packages/matching/src/scoring/scoreSponsorship.ts`:
```typescript
import type { Sponsorship } from "../types";

/** The hard "required but not offered" mismatch is already excluded before scoring (Task 1). */
export function scoreSponsorship(required: boolean | null, jobSponsorship: Sponsorship): number {
  if (required !== true) return 1;
  if (jobSponsorship === "offered") return 1;
  if (jobSponsorship === "unknown") return 0.5;
  return 0;
}
```

`packages/matching/src/scoring/scoreRole.ts`:
```typescript
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean));
}

/** Word-overlap ratio between the job title and every stated target role, combined -- deliberately simple and explainable rather than a fuzzy-match library. */
export function scoreRole(targetRoles: string[], jobTitle: string): number {
  if (targetRoles.length === 0) return 1;
  const titleWords = words(jobTitle);
  if (titleWords.size === 0) return 0.5;
  const goalWords = new Set(targetRoles.flatMap((role) => [...words(role)]));
  if (goalWords.size === 0) return 0.5;
  const overlap = [...titleWords].filter((w) => goalWords.has(w)).length;
  return Math.min(1, overlap / Math.min(titleWords.size, goalWords.size));
}
```

`packages/matching/src/scoring/scoreSalary.ts`:
```typescript
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
```

`packages/matching/src/scoring/scoreIndustry.ts`:
```typescript
/** Refinement #3: company-name-only heuristic (no structured `industry` field exists yet). Never penalizes a non-match, only fails to boost it. */
export function scoreIndustry(companyName: string, preferredIndustries: string[]): number {
  if (preferredIndustries.length === 0) return 1;
  const name = companyName.toLowerCase();
  return preferredIndustries.some((term) => name.includes(term.toLowerCase())) ? 1 : 0.5;
}
```

`packages/matching/src/scoring/scoreFreshness.ts`:
```typescript
const MS_PER_HOUR = 3_600_000;

/** Full credit under 24h (spec §9); exponential decay after that with a configurable half-life. Falls back to `firstSeenAt` when the source gave no posted date (labeled as such by the caller, matching Phase 4's own convention). */
export function scoreFreshness(postedAt: Date | null, firstSeenAt: Date, halfLifeHours: number, now: Date): number {
  const referenceDate = postedAt ?? firstSeenAt;
  const ageHours = Math.max(0, (now.getTime() - referenceDate.getTime()) / MS_PER_HOUR);
  if (ageHours <= 24) return 1;
  return Math.pow(0.5, ageHours / halfLifeHours);
}
```

`packages/matching/src/scoring/scoreSemantic.ts`:
```typescript
/** Refinement #2: the "overall contextual fit" factor -- the raw job<->goal cosine similarity, unblended. Unknown (no embedding yet) is neutral, never zero. */
export function scoreSemantic(similarity: number | null): number {
  return similarity ?? 0.5;
}
```

`packages/matching/src/scoring/computeOverallScore.ts`:
```typescript
import { FACTOR_WEIGHTS, type FactorScores } from "../types";

/**
 * Weighted sum on a 0-100 scale, one decimal place. A factor whose value is `null` (only
 * `salaryScore` can be, today) has its weight redistributed proportionally across the known
 * factors rather than being treated as a zero (design doc §6).
 */
export function computeOverallScore(factors: FactorScores): number {
  const entries = Object.entries(factors) as [keyof FactorScores, number | null][];
  const known = entries.filter((entry): entry is [keyof FactorScores, number] => entry[1] !== null);
  const knownWeightTotal = known.reduce((sum, [key]) => sum + FACTOR_WEIGHTS[key], 0);
  if (knownWeightTotal === 0) return 0;
  const weighted = known.reduce((sum, [key, value]) => sum + (FACTOR_WEIGHTS[key] / knownWeightTotal) * value, 0);
  return Math.round(weighted * 1000) / 10;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ai-career/matching test`
Expected: PASS — all scoring test files green.

- [ ] **Step 5: Export everything from the package index**

`packages/matching/src/index.ts`:
```typescript
export * from "./types";
export * from "./eligibility/evaluateEligibility";
export * from "./scoring/scoreSkills";
export * from "./scoring/scoreExperience";
export * from "./scoring/scoreLocation";
export * from "./scoring/scoreSponsorship";
export * from "./scoring/scoreRole";
export * from "./scoring/scoreSalary";
export * from "./scoring/scoreIndustry";
export * from "./scoring/scoreFreshness";
export * from "./scoring/scoreSemantic";
export * from "./scoring/computeOverallScore";
```

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm --filter @ai-career/matching typecheck && pnpm --filter @ai-career/matching lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add packages/matching/src/scoring packages/matching/src/index.ts
git commit -m "feat(matching): deterministic per-factor scoring and weighted overall score"
```

### Task 3: Database schema — job/goal embeddings, `job_matches`, `matching_runs`, migrations, RLS

**Files:**
- Modify: `packages/db/src/schema/jobs.ts`, `packages/db/src/schema/careerGoalConstraints.ts`, `packages/db/src/schema/index.ts`
- Create: `packages/db/src/schema/jobMatches.ts`, `packages/db/src/schema/matchingRuns.ts`
- Create (generated): migration files under `packages/db/migrations/` + `meta/` updates
- Test: `packages/db/src/matchingTables.rls.test.ts`

**Interfaces:**
- Produces: `jobMatches`, `matchingRuns` tables; `jobMatchUserActionEnum` (`"none" | "saved" | "dismissed"`), `matchingRunStatusEnum` (`"running" | "completed" | "failed"`); `jobs.embedding` / `jobs.embeddingContentHash` / `jobs.embeddingModel`; `careerGoalConstraints.embedding` / `careerGoalConstraints.embeddingModel`. All consumed by Tasks 5–8.

- [ ] **Step 1: Write the failing RLS test**

`packages/db/src/matchingTables.rls.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { withUserContext } from "./rls";
import { createDbClient } from "./client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";
const adminSql = postgres(ADMIN_URL);
const db = createDbClient({ DATABASE_URL: APP_URL });

const USER_A = "00000000-0000-0000-0000-0000000000f5";
const USER_B = "00000000-0000-0000-0000-0000000000f6";
const TABLES = ["job_matches", "matching_runs"] as const;

async function wipe() {
  await adminSql`DELETE FROM job_matches WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM matching_runs WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM jobs WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM career_goals WHERE user_id IN (${USER_A}, ${USER_B})`;
}

beforeAll(async () => {
  await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
  await adminSql.unsafe("GRANT USAGE ON SCHEMA public TO career_intel_app");
  await adminSql.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app");
  await wipe();
});

afterAll(async () => {
  await wipe();
  await adminSql.end();
});

async function seedUserA(): Promise<void> {
  const [goal] = await adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER_A}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [job] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER_A}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', now(), now()) RETURNING id`;
  const [run] = await adminSql`
    INSERT INTO matching_runs (user_id, career_goal_id, started_at, status)
    VALUES (${USER_A}, ${goal.id}, now(), 'completed') RETURNING id`;
  await adminSql`
    INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, computed_at)
    VALUES (${USER_A}, ${job.id}, ${goal.id}, true, now())`;
  return run.id;
}

describe("matching tables — RLS", () => {
  it("isolates job_matches and matching_runs by user_id", async () => {
    await seedUserA();
    for (const table of TABLES) {
      const asA = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      const asB = await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      expect((asA as unknown as { n: number }[])[0].n, `${table} as A`).toBeGreaterThan(0);
      expect((asB as unknown as { n: number }[])[0].n, `${table} as B`).toBe(0);
    }
  });

  it("enforces one job_matches row per (user_id, job_id)", async () => {
    await wipe();
    await seedUserA();
    const [job] = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT id FROM jobs LIMIT 1`)) as unknown as { id: string }[];
    const [goal] = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT id FROM career_goals LIMIT 1`)) as unknown as { id: string }[];
    await expect(
      withUserContext(db, USER_A, (tx) =>
        tx.execute(sql`INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, computed_at)
                        VALUES (${USER_A}, ${job.id}, ${goal.id}, true, now())`)
      )
    ).rejects.toThrow();
  });

  it("defaults job_matches.user_action to 'none'", async () => {
    await wipe();
    await seedUserA();
    const rows = await withUserContext(db, USER_A, (tx) =>
      tx.execute(sql`SELECT user_action FROM job_matches LIMIT 1`)
    ) as unknown as { user_action: string }[];
    expect(rows[0].user_action).toBe("none");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ai-career/db test -- matchingTables`
Expected: FAIL — `job_matches`/`matching_runs` don't exist.

- [ ] **Step 3: Add the embedding columns to `jobs` and `career_goal_constraints`**

In `packages/db/src/schema/jobs.ts`, add the `vector` import and three columns just before `createdAt`:

```typescript
import {
  pgTable, pgEnum, uuid, text, integer, numeric, boolean, jsonb, timestamp, vector,
} from "drizzle-orm/pg-core";
```
```typescript
  fieldProvenance: jsonb("field_provenance").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),

  // Phase 5: title + descriptionText embedding for hybrid semantic retrieval. Nullable until a
  // matching run first generates it (packages/matching/src/embeddings/ensureJobEmbeddings.ts).
  // Same 1024-dim convention as profile_facts.embedding.
  embedding: vector("embedding", { dimensions: 1024 }),
  // The descriptionHash this embedding was generated from -- a permanent, content-hash-keyed cache,
  // same pattern as profile_facts (D-line52). Regenerated only when descriptionHash no longer matches.
  embeddingContentHash: text("embedding_content_hash"),
  embeddingModel: text("embedding_model"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
```

In `packages/db/src/schema/careerGoalConstraints.ts`, add the `vector` import and two columns at the end:

```typescript
import { pgTable, uuid, text, integer, numeric, boolean, pgEnum, vector } from "drizzle-orm/pg-core";
```
```typescript
  hardConstraints: text("hard_constraints").array().notNull().default(sql`ARRAY[]::text[]`),
  // Phase 5: embeds targetRoles + skills + the goal's rawText -- the semantic query vector for
  // retrieval against jobs.embedding. Generated once on confirm (apps/web's saveCareerGoal.ts);
  // never recomputed for a given row since a career_goals row is immutable once created (D23).
  embedding: vector("embedding", { dimensions: 1024 }),
  embeddingModel: text("embedding_model"),
});
```

- [ ] **Step 4: Write the `job_matches` and `matching_runs` schema**

`packages/db/src/schema/jobMatches.ts`:
```typescript
import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, numeric, boolean, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { careerGoals } from "./careerGoals";

export const jobMatchUserActionEnum = pgEnum("job_match_user_action", ["none", "saved", "dismissed"]);

/**
 * One row per (user, job), overwritten in place on each matching run -- not versioned like
 * career_goals (design doc §3). Also the "saved/dismissed jobs" mechanism (spec §19) until Phase 9's
 * application tracker exists. An ineligible job still gets a row (eligible=false + reason) instead
 * of being silently dropped, so eligibility stays explainable (CLAUDE.md §6).
 */
export const jobMatches = pgTable(
  "job_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    careerGoalId: uuid("career_goal_id")
      .notNull()
      .references(() => careerGoals.id, { onDelete: "cascade" }),
    eligible: boolean("eligible").notNull(),
    ineligibleReason: text("ineligible_reason"),

    skillsScore: numeric("skills_score"),
    experienceScore: numeric("experience_score"),
    locationScore: numeric("location_score"),
    sponsorshipScore: numeric("sponsorship_score"),
    roleScore: numeric("role_score"),
    salaryScore: numeric("salary_score"),
    industryScore: numeric("industry_score"),
    freshnessScore: numeric("freshness_score"),
    semanticScore: numeric("semantic_score"),
    overallScore: numeric("overall_score"),

    // { strongMatches: string[], partialMatches: string[], gaps: string[], summary: string } | null
    explanation: jsonb("explanation"),
    explanationModel: text("explanation_model"),
    // Refinement #1: the jobs.description_hash the current explanation was generated against, so
    // staleness can be detected (design doc §7) instead of only ever comparing to the live hash.
    explanationDescriptionHash: text("explanation_description_hash"),
    explanationGeneratedAt: timestamp("explanation_generated_at", { withTimezone: true }),

    userAction: jobMatchUserActionEnum("user_action").notNull().default("none"),
    userActionAt: timestamp("user_action_at", { withTimezone: true }),

    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userJobUniq: uniqueIndex("job_matches_user_job_uniq").on(t.userId, t.jobId),
  })
);
```

`packages/db/src/schema/matchingRuns.ts`:
```typescript
import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, integer, text, timestamp } from "drizzle-orm/pg-core";
import { careerGoals } from "./careerGoals";

export const matchingRunStatusEnum = pgEnum("matching_run_status", ["running", "completed", "failed"]);

/** One row per recompute, mirrors ingestion_runs (design doc §3). */
export const matchingRuns = pgTable("matching_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  careerGoalId: uuid("career_goal_id")
    .notNull()
    .references(() => careerGoals.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: matchingRunStatusEnum("status").notNull().default("running"),
  errorClass: text("error_class"),
  jobsEvaluated: integer("jobs_evaluated").notNull().default(0),
  jobsEligible: integer("jobs_eligible").notNull().default(0),
  jobsExplained: integer("jobs_explained").notNull().default(0),
});
```

Add both to `packages/db/src/schema/index.ts`:
```typescript
export * from "./jobDuplicateCandidates";
export * from "./jobMatches";
export * from "./matchingRuns";
```

- [ ] **Step 5: Generate the migrations**

```bash
pnpm --filter @ai-career/db exec dotenv -e ../../.env -- drizzle-kit generate --name=hybrid_matching
pnpm --filter @ai-career/db exec dotenv -e ../../.env -- drizzle-kit generate --custom --name=hybrid_matching_rls_and_indexes
```

Expected: two new files in `packages/db/migrations/` (numbered after `0010_job_intelligence_rls_and_indexes.sql`) and `meta/_journal.json` updated. Open the first and confirm it alters `jobs`/`career_goal_constraints` (three/two new nullable columns) and creates the two new enums and tables.

Before writing the custom migration's body, confirm the installed pgvector version supports HNSW (added in 0.5.0):

```bash
docker compose -f infra/docker-compose.yml exec postgres psql -U career_intel -d career_intel -c \
  "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
```

If the version is `>= 0.5.0` (expected for the `pgvector/pgvector:pg16` image), replace the custom migration's body with:

```sql
-- Custom SQL migration: RLS and the indexes drizzle-kit cannot generate.
-- Follows 0001_users_rls.sql / 0007_career_goal_rls.sql / 0010_job_intelligence_rls_and_indexes.sql.

ALTER TABLE job_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON job_matches
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE matching_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON matching_runs
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- Ranked-list query: a user's eligible matches, best first (Task 10's GET /api/matches).
CREATE INDEX job_matches_user_eligible_score_idx ON job_matches (user_id, eligible, overall_score DESC);
CREATE INDEX matching_runs_user_started_idx ON matching_runs (user_id, started_at DESC);

-- HNSW cosine index for Task 6's semantic-retrieval query. Requires pgvector >= 0.5.0, confirmed
-- above against the running pgvector/pgvector:pg16 image.
CREATE INDEX jobs_embedding_hnsw_idx ON jobs USING hnsw (embedding vector_cosine_ops);
```

(If the installed version is older than 0.5.0, use `CREATE INDEX jobs_embedding_ivfflat_idx ON jobs USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);` instead, and note the substitution in this task's commit message.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @ai-career/db test && pnpm --filter @ai-career/db typecheck`
Expected: PASS. Also apply to the dev database: `pnpm --filter @ai-career/db db:migrate`.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema packages/db/migrations pnpm-lock.yaml
git commit -m "feat(db): jobs/career_goal_constraints embeddings, job_matches, matching_runs, RLS"
```

### Task 4: Embedding helpers — `ensureGoalEmbedding`, `ensureJobEmbeddings`

**Files:**
- Create: `packages/matching/src/embeddings/vectorLiteral.ts`, `ensureGoalEmbedding.ts`, `ensureJobEmbeddings.ts`
- Test: `vectorLiteral.test.ts`, `ensureGoalEmbedding.test.ts`, `ensureJobEmbeddings.test.ts`
- Create: `packages/matching/src/testing/db.ts` (integration-test DB helper, mirrors `packages/ingestion/src/testing/db.ts`)

**Interfaces:**
- Consumes: `embedTexts` from `@ai-career/ai` (existing); `schema.jobs`, `schema.careerGoalConstraints`, `withUserContext`, `DbClient` from `@ai-career/db`.
- Produces: `toVectorLiteral(embedding): string`; `ensureGoalEmbedding(tx, env, careerGoalConstraintsId): Promise<number[] | null>`; `ensureJobEmbeddings(tx, env, jobIds): Promise<void>` — both consumed by Task 8's pipeline and by Task 12's confirm-route edit.

- [ ] **Step 1: Write the failing unit test for the vector literal helper**

`packages/matching/src/embeddings/vectorLiteral.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { toVectorLiteral } from "./vectorLiteral";

describe("toVectorLiteral", () => {
  it("formats a numeric array as a pgvector literal", () => {
    expect(toVectorLiteral([0.1, -0.25, 1])).toBe("[0.1,-0.25,1]");
  });
  it("formats an empty array", () => {
    expect(toVectorLiteral([])).toBe("[]");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ai-career/matching test -- vectorLiteral`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `toVectorLiteral`**

`packages/matching/src/embeddings/vectorLiteral.ts`:
```typescript
/** pgvector's text input format for a `vector` column/literal: `[v1,v2,...]`. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
```

- [ ] **Step 4: Add the integration-test DB helper**

`packages/matching/src/testing/db.ts`:
```typescript
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDbClient, createDbClient, type DbClient } from "@ai-career/db";

// packages/matching/src/testing -> packages/db/migrations
const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";

export interface TestDb {
  adminSql: postgres.Sql;
  db: DbClient;
  close(): Promise<void>;
}

// Same advisory-lock rationale as packages/ingestion/src/testing/db.ts: concurrent migrate() calls
// on an empty database collide.
const MIGRATION_LOCK = 7420001;

export async function openTestDb(): Promise<TestDb> {
  const adminSql = postgres(ADMIN_URL);
  const lock = await adminSql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
    await adminSql.unsafe("GRANT USAGE ON SCHEMA public TO career_intel_app");
    await adminSql.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app");
  } finally {
    await lock`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    lock.release();
  }
  const db = createDbClient({ DATABASE_URL: APP_URL });
  return {
    adminSql,
    db,
    close: async () => {
      await closeDbClient(db);
      await adminSql.end();
    },
  };
}

export async function wipeUser(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM job_matches WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM matching_runs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM jobs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM career_goals WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM candidate_profiles WHERE user_id = ${userId}`;
}
```

`packages/matching/src/testing/index.ts`:
```typescript
export * from "./db";
```

- [ ] **Step 5: Write the failing test for `ensureGoalEmbedding`**

`packages/matching/src/embeddings/ensureGoalEmbedding.test.ts`:
```typescript
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { schema, withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { ensureGoalEmbedding } from "./ensureGoalEmbedding";

vi.mock("@ai-career/ai", () => ({ embedTexts: vi.fn() }));
import { embedTexts } from "@ai-career/ai";

const USER = "00000000-0000-0000-0000-0000000000e1";
const ENV = { EMBEDDING_PROVIDER: "voyage" as const, VOYAGE_API_KEY: "k", VOYAGE_EMBEDDING_MODEL: "voyage-3.5" };
let testDb: TestDb;

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  vi.mocked(embedTexts).mockReset();
  await wipeUser(testDb.adminSql, USER);
});

async function seedConstraints(): Promise<string> {
  const [goal] = await testDb.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER}, 'Data roles in Berlin', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [constraints] = await testDb.adminSql`
    INSERT INTO career_goal_constraints (user_id, career_goal_id, target_roles, skills)
    VALUES (${USER}, ${goal.id}, ARRAY['Data Engineer'], ARRAY['SQL','Python']) RETURNING id`;
  return constraints.id as string;
}

describe("ensureGoalEmbedding", () => {
  it("embeds targetRoles + skills + rawText and stores the result", async () => {
    vi.mocked(embedTexts).mockResolvedValue([[0.1, 0.2, 0.3]]);
    const constraintsId = await seedConstraints();
    const embedding = await withUserContext(testDb.db, USER, (tx) => ensureGoalEmbedding(tx, ENV, constraintsId));
    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(embedTexts).toHaveBeenCalledWith(ENV, [expect.stringContaining("Data Engineer")]);
    const [row] = await withUserContext(testDb.db, USER, (tx) =>
      tx.select().from(schema.careerGoalConstraints).where(eq(schema.careerGoalConstraints.id, constraintsId))
    );
    expect(row.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(row.embeddingModel).toBe("voyage-3.5");
  });

  it("returns the existing embedding without calling Voyage again when already set", async () => {
    vi.mocked(embedTexts).mockResolvedValue([[0.9, 0.9, 0.9]]);
    const constraintsId = await seedConstraints();
    await withUserContext(testDb.db, USER, (tx) => ensureGoalEmbedding(tx, ENV, constraintsId));
    vi.mocked(embedTexts).mockClear();
    const second = await withUserContext(testDb.db, USER, (tx) => ensureGoalEmbedding(tx, ENV, constraintsId));
    expect(second).toEqual([0.9, 0.9, 0.9]);
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("returns null and leaves the row unembedded when Voyage fails, without throwing", async () => {
    vi.mocked(embedTexts).mockRejectedValue(new Error("voyage down"));
    const constraintsId = await seedConstraints();
    const embedding = await withUserContext(testDb.db, USER, (tx) => ensureGoalEmbedding(tx, ENV, constraintsId));
    expect(embedding).toBeNull();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @ai-career/matching test -- ensureGoalEmbedding`
Expected: FAIL — module does not exist. (Requires local Postgres/Redis up: `docker compose -f infra/docker-compose.yml up -d`.)

- [ ] **Step 7: Implement `ensureGoalEmbedding`**

`packages/matching/src/embeddings/ensureGoalEmbedding.ts`:
```typescript
import { eq } from "drizzle-orm";
import { embedTexts } from "@ai-career/ai";
import { schema, type DbClient } from "@ai-career/db";
import type { Env } from "@ai-career/config";
import { toVectorLiteral } from "./vectorLiteral";

const { careerGoalConstraints, careerGoals } = schema;

/**
 * Generates and stores `career_goal_constraints.embedding` if it is not already set. Returns the
 * embedding (existing or freshly generated), or null if generation fails or there is no text to
 * embed. Never throws -- a Voyage outage must not block a matching run (mirrors saveProfile.ts's
 * "degrade to null" rule for profile_facts).
 */
export async function ensureGoalEmbedding(
  tx: DbClient,
  env: Pick<Env, "EMBEDDING_PROVIDER" | "VOYAGE_API_KEY" | "VOYAGE_EMBEDDING_MODEL">,
  careerGoalConstraintsId: string
): Promise<number[] | null> {
  const [row] = await tx
    .select({
      embedding: careerGoalConstraints.embedding,
      targetRoles: careerGoalConstraints.targetRoles,
      skills: careerGoalConstraints.skills,
      careerGoalId: careerGoalConstraints.careerGoalId,
    })
    .from(careerGoalConstraints)
    .where(eq(careerGoalConstraints.id, careerGoalConstraintsId))
    .limit(1);
  if (!row) return null;
  if (row.embedding) return row.embedding;

  const [goal] = await tx.select({ rawText: careerGoals.rawText }).from(careerGoals).where(eq(careerGoals.id, row.careerGoalId)).limit(1);
  const text = [...row.targetRoles, ...row.skills, goal?.rawText ?? ""].filter(Boolean).join(" ");
  if (!text.trim()) return null;

  let embedding: number[] | null;
  try {
    [embedding] = await embedTexts(env, [text]);
  } catch {
    // Swallowed on purpose: the error may echo the goal text (PII), which CLAUDE.md §9 forbids logging.
    return null;
  }
  if (!embedding) return null;

  await tx
    .update(careerGoalConstraints)
    .set({ embedding, embeddingModel: env.VOYAGE_EMBEDDING_MODEL })
    .where(eq(careerGoalConstraints.id, careerGoalConstraintsId));
  return embedding;
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm --filter @ai-career/matching test -- ensureGoalEmbedding`
Expected: PASS.

- [ ] **Step 9: Write the failing test for `ensureJobEmbeddings`**

`packages/matching/src/embeddings/ensureJobEmbeddings.test.ts`:
```typescript
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { schema, withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { ensureJobEmbeddings } from "./ensureJobEmbeddings";

vi.mock("@ai-career/ai", () => ({ embedTexts: vi.fn() }));
import { embedTexts } from "@ai-career/ai";

const USER = "00000000-0000-0000-0000-0000000000e2";
const ENV = { EMBEDDING_PROVIDER: "voyage" as const, VOYAGE_API_KEY: "k", VOYAGE_EMBEDDING_MODEL: "voyage-3.5" };
let testDb: TestDb;

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  vi.mocked(embedTexts).mockReset();
  await wipeUser(testDb.adminSql, USER);
});

async function seedJob(descriptionHash: string, embedding: number[] | null = null, embeddingContentHash: string | null = null) {
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_text, description_hash,
                       first_seen_at, last_verified_at, embedding, embedding_content_hash, embedding_model)
    VALUES (${USER}, 'Acme', 'acme', 'Engineer', 'engineer', 'We use SQL.', ${descriptionHash}, now(), now(),
            ${embedding ? testDb.adminSql`${JSON.stringify(embedding)}::vector` : null}, ${embeddingContentHash}, ${embedding ? "voyage-3.5" : null})
    RETURNING id`;
  return job.id as string;
}

describe("ensureJobEmbeddings", () => {
  it("embeds a job with no embedding yet", async () => {
    vi.mocked(embedTexts).mockResolvedValue([[0.1, 0.2]]);
    const jobId = await seedJob("hash-1");
    await withUserContext(testDb.db, USER, (tx) => ensureJobEmbeddings(tx, ENV, [jobId]));
    const [row] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)));
    expect(row.embedding).toEqual([0.1, 0.2]);
    expect(row.embeddingContentHash).toBe("hash-1");
  });

  it("skips a job whose embeddingContentHash already matches its current descriptionHash", async () => {
    const jobId = await seedJob("hash-1", [0.9, 0.9], "hash-1");
    await withUserContext(testDb.db, USER, (tx) => ensureJobEmbeddings(tx, ENV, [jobId]));
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("re-embeds a job whose descriptionHash changed since its stored embeddingContentHash", async () => {
    vi.mocked(embedTexts).mockResolvedValue([[0.5, 0.5]]);
    const jobId = await seedJob("hash-2", [0.1, 0.1], "hash-1");
    await withUserContext(testDb.db, USER, (tx) => ensureJobEmbeddings(tx, ENV, [jobId]));
    const [row] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)));
    expect(row.embedding).toEqual([0.5, 0.5]);
    expect(row.embeddingContentHash).toBe("hash-2");
  });

  it("leaves a job's embedding untouched and does not throw when Voyage fails", async () => {
    vi.mocked(embedTexts).mockRejectedValue(new Error("voyage down"));
    const jobId = await seedJob("hash-1");
    await expect(withUserContext(testDb.db, USER, (tx) => ensureJobEmbeddings(tx, ENV, [jobId]))).resolves.not.toThrow();
    const [row] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)));
    expect(row.embedding).toBeNull();
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm --filter @ai-career/matching test -- ensureJobEmbeddings`
Expected: FAIL — module does not exist.

- [ ] **Step 11: Implement `ensureJobEmbeddings`**

`packages/matching/src/embeddings/ensureJobEmbeddings.ts`:
```typescript
import { eq, inArray, and, ne, isNull, or } from "drizzle-orm";
import { embedTexts } from "@ai-career/ai";
import { schema, type DbClient } from "@ai-career/db";
import type { Env } from "@ai-career/config";

const { jobs } = schema;

/**
 * Generates and stores an embedding for every job in `jobIds` whose `embeddingContentHash` does not
 * match its current `descriptionHash` (including never-embedded jobs, where the hash is null).
 * Batches all texts into one Voyage call; a batch failure leaves every affected job's embedding
 * untouched rather than throwing (same "degrade, never block the run" rule as `ensureGoalEmbedding`).
 */
export async function ensureJobEmbeddings(
  tx: DbClient,
  env: Pick<Env, "EMBEDDING_PROVIDER" | "VOYAGE_API_KEY" | "VOYAGE_EMBEDDING_MODEL">,
  jobIds: string[]
): Promise<void> {
  if (jobIds.length === 0) return;

  const stale = await tx
    .select({ id: jobs.id, title: jobs.title, descriptionText: jobs.descriptionText, descriptionHash: jobs.descriptionHash })
    .from(jobs)
    .where(
      and(
        inArray(jobs.id, jobIds),
        or(isNull(jobs.embeddingContentHash), ne(jobs.embeddingContentHash, jobs.descriptionHash))
      )
    );
  if (stale.length === 0) return;

  let embeddings: number[][];
  try {
    embeddings = await embedTexts(
      env,
      stale.map((job) => `${job.title} ${job.descriptionText}`)
    );
  } catch {
    // Swallowed: job content must never be logged (CLAUDE.md §9), and a Voyage outage must not fail
    // the whole matching run -- these jobs simply keep scoring with semanticScore's "unknown" default.
    return;
  }

  for (const [index, job] of stale.entries()) {
    const embedding = embeddings[index];
    if (!embedding) continue;
    await tx
      .update(jobs)
      .set({ embedding, embeddingContentHash: job.descriptionHash, embeddingModel: env.VOYAGE_EMBEDDING_MODEL })
      .where(eq(jobs.id, job.id));
  }
}
```

- [ ] **Step 12: Run it to verify it passes**

Run: `pnpm --filter @ai-career/matching test -- ensureJobEmbeddings`
Expected: PASS.

- [ ] **Step 13: Export the new modules**

Add to `packages/matching/src/index.ts`:
```typescript
export * from "./embeddings/vectorLiteral";
export * from "./embeddings/ensureGoalEmbedding";
export * from "./embeddings/ensureJobEmbeddings";
```

- [ ] **Step 14: Typecheck, lint, full package test**

Run: `pnpm --filter @ai-career/matching typecheck && pnpm --filter @ai-career/matching lint && pnpm --filter @ai-career/matching test`
Expected: all clean.

- [ ] **Step 15: Commit**

```bash
git add packages/matching/src/embeddings packages/matching/src/testing packages/matching/src/index.ts
git commit -m "feat(matching): embedding helpers for career-goal and job content-hash caches"
```

### Task 5: Hybrid retrieval — `fetchCandidateJobs`

**Files:**
- Create: `packages/matching/src/retrieval/fetchCandidateJobs.ts`
- Test: `packages/matching/src/retrieval/fetchCandidateJobs.test.ts`

**Interfaces:**
- Consumes: `schema.jobs`, `DbClient` from `@ai-career/db`; `toVectorLiteral` (Task 4).
- Produces: `CandidateJobRow`, `fetchCandidateJobs(tx, goalEmbedding): Promise<CandidateJobRow[]>` — consumed by Task 8's pipeline.

- [ ] **Step 1: Write the failing integration test**

`packages/matching/src/retrieval/fetchCandidateJobs.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { fetchCandidateJobs } from "./fetchCandidateJobs";

const USER = "00000000-0000-0000-0000-0000000000e3";
let testDb: TestDb;

// vector(1024) is a fixed dimension; pad short test vectors with zeros so inserts succeed.
const vec = (entries: number[]): number[] => [...entries, ...new Array(1024 - entries.length).fill(0)];

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(() => wipeUser(testDb.adminSql, USER));

async function seedJob(opts: { title?: string; status?: "open" | "closed"; embedding?: number[] | null }) {
  await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_text, description_hash,
                       status, first_seen_at, last_verified_at, embedding)
    VALUES (${USER}, 'Acme', 'acme', ${opts.title ?? "Engineer"}, 'engineer', 'We use SQL.', ${"hash-" + Math.random()},
            ${opts.status ?? "open"}, now(), now(),
            ${opts.embedding === undefined ? null : opts.embedding === null ? null : testDb.adminSql`${JSON.stringify(opts.embedding)}::vector`})`;
}

describe("fetchCandidateJobs", () => {
  it("returns only open jobs", async () => {
    await seedJob({ title: "Open Role", status: "open" });
    await seedJob({ title: "Closed Role", status: "closed" });
    const rows = await withUserContext(testDb.db, USER, (tx) => fetchCandidateJobs(tx, null));
    expect(rows.map((r) => r.title)).toEqual(["Open Role"]);
  });

  it("returns null semanticSimilarity when no goal embedding is given", async () => {
    await seedJob({ embedding: vec([1, 0, 0]) });
    const rows = await withUserContext(testDb.db, USER, (tx) => fetchCandidateJobs(tx, null));
    expect(rows[0].semanticSimilarity).toBeNull();
  });

  it("returns null semanticSimilarity for a job with no embedding, even with a goal embedding given", async () => {
    await seedJob({ embedding: null });
    const rows = await withUserContext(testDb.db, USER, (tx) => fetchCandidateJobs(tx, vec([1, 0, 0])));
    expect(rows[0].semanticSimilarity).toBeNull();
  });

  it("computes cosine similarity of 1 for identical vectors and lower for dissimilar ones", async () => {
    await seedJob({ title: "Aligned", embedding: vec([1, 0, 0]) });
    await seedJob({ title: "Orthogonal", embedding: vec([0, 1, 0]) });
    const rows = await withUserContext(testDb.db, USER, (tx) => fetchCandidateJobs(tx, vec([1, 0, 0])));
    const aligned = rows.find((r) => r.title === "Aligned")!;
    const orthogonal = rows.find((r) => r.title === "Orthogonal")!;
    expect(aligned.semanticSimilarity).toBeCloseTo(1, 5);
    expect(orthogonal.semanticSimilarity).toBeCloseTo(0, 5);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ai-career/matching test -- fetchCandidateJobs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `fetchCandidateJobs`**

`packages/matching/src/retrieval/fetchCandidateJobs.ts`:
```typescript
import { eq, sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import type { Sponsorship, WorkMode } from "../types";
import { toVectorLiteral } from "../embeddings/vectorLiteral";

const { jobs } = schema;

export interface CandidateJobRow {
  id: string;
  companyName: string;
  title: string;
  locationRaw: string | null;
  countryCode: string | null;
  workMode: WorkMode;
  descriptionText: string;
  descriptionHash: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryIsParsed: boolean;
  minExperienceYears: number | null;
  sponsorship: Sponsorship;
  postedAt: Date | null;
  firstSeenAt: Date;
  /** 1 - cosine distance against the goal's embedding; null when either embedding is missing. */
  semanticSimilarity: number | null;
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * Every open job, scored deterministically downstream (Task 8) -- this is not a top-K filter, only
 * the semantic-similarity computation (best done in Postgres via pgvector's `<=>`, not by pulling
 * 1024-dim vectors into Node) plus the plain fields every scoring factor needs.
 */
export async function fetchCandidateJobs(tx: DbClient, goalEmbedding: number[] | null): Promise<CandidateJobRow[]> {
  const similarityExpr = goalEmbedding
    ? sql<string | null>`CASE WHEN ${jobs.embedding} IS NULL THEN NULL ELSE 1 - (${jobs.embedding} <=> ${toVectorLiteral(goalEmbedding)}::vector) END`
    : sql<string | null>`NULL`;

  const rows = await tx
    .select({
      id: jobs.id,
      companyName: jobs.companyName,
      title: jobs.title,
      locationRaw: jobs.locationRaw,
      countryCode: jobs.countryCode,
      workMode: jobs.workMode,
      descriptionText: jobs.descriptionText,
      descriptionHash: jobs.descriptionHash,
      salaryMin: jobs.salaryMin,
      salaryMax: jobs.salaryMax,
      salaryCurrency: jobs.salaryCurrency,
      salaryIsParsed: jobs.salaryIsParsed,
      minExperienceYears: jobs.minExperienceYears,
      sponsorship: jobs.sponsorship,
      postedAt: jobs.postedAt,
      firstSeenAt: jobs.firstSeenAt,
      semanticSimilarity: similarityExpr,
    })
    .from(jobs)
    .where(eq(jobs.status, "open"));

  return rows.map((row) => ({
    ...row,
    salaryMin: num(row.salaryMin),
    salaryMax: num(row.salaryMax),
    semanticSimilarity: row.semanticSimilarity === null ? null : Number(row.semanticSimilarity),
  }));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @ai-career/matching test -- fetchCandidateJobs`
Expected: PASS.

- [ ] **Step 5: Export and verify**

Add to `packages/matching/src/index.ts`: `export * from "./retrieval/fetchCandidateJobs";`

Run: `pnpm --filter @ai-career/matching typecheck && pnpm --filter @ai-career/matching lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/matching/src/retrieval packages/matching/src/index.ts
git commit -m "feat(matching): hybrid retrieval query with pgvector cosine similarity"
```

### Task 6: AI match reasoning — `generateMatchExplanation`

**Files:**
- Create: `packages/matching/src/explanation/matchExplanationSchema.ts`, `generateMatchExplanation.ts`
- Test: `generateMatchExplanation.test.ts`

**Interfaces:**
- Produces: `MatchExplanationSchema` (Zod), `MatchExplanationDraft`, `MatchExplanationInput`, `MatchExplanationValidationError`, `generateMatchExplanation(client, env, input): Promise<MatchExplanationDraft>` — consumed by Task 8's pipeline.

- [ ] **Step 1: Write the schema**

`packages/matching/src/explanation/matchExplanationSchema.ts`:
```typescript
import { z } from "zod";

/** design doc §7: strong/partial/missing, never a bare score (CLAUDE.md §6). */
export const MatchExplanationSchema = z.object({
  strongMatches: z.array(z.string()),
  partialMatches: z.array(z.string()),
  gaps: z.array(z.string()),
  summary: z.string(),
});

export type MatchExplanationDraft = z.infer<typeof MatchExplanationSchema>;
```

- [ ] **Step 2: Write the failing test**

`packages/matching/src/explanation/generateMatchExplanation.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { generateMatchExplanation, MatchExplanationValidationError, type MatchExplanationInput } from "./generateMatchExplanation";

type FakeClient = Pick<Anthropic, "messages">;

const validInput: MatchExplanationInput = {
  jobTitle: "Data Engineer",
  companyName: "Acme",
  overallScore: 82,
  skillMatches: [{ skill: "SQL", found: true }, { skill: "Tableau", found: false }],
  experience: { requiredYears: 3, candidateYears: 5 },
  workMode: { job: "remote", goal: "remote" },
  sponsorship: { required: true, job: "offered" },
  salary: { comparable: true, withinRange: true },
  freshnessDays: 2,
};

const validDraft = {
  strongMatches: ["Strong SQL alignment", "Remote work mode matches"],
  partialMatches: ["3 years required, you have 5"],
  gaps: ["Tableau requested; not found in your listed skills"],
  summary: "A strong overall match with one notable skill gap.",
};

function fakeClient(toolUseInput: unknown, hasToolUse = true): FakeClient {
  return {
    messages: {
      create: async () => ({
        content: hasToolUse
          ? [{ type: "tool_use", id: "t1", name: "record_match_explanation", input: toolUseInput }]
          : [{ type: "text", text: "no tool use" }],
      }),
    } as unknown as Anthropic["messages"],
  };
}

describe("generateMatchExplanation", () => {
  it("returns the validated draft on a well-formed tool_use response", async () => {
    const draft = await generateMatchExplanation(fakeClient(validDraft), { ANTHROPIC_MODEL_FAST: "test-model" }, validInput);
    expect(draft.summary).toBe(validDraft.summary);
    expect(draft.gaps).toContain("Tableau requested; not found in your listed skills");
  });

  it("throws MatchExplanationValidationError when there is no tool_use block", async () => {
    await expect(
      generateMatchExplanation(fakeClient(validDraft, false), { ANTHROPIC_MODEL_FAST: "test-model" }, validInput)
    ).rejects.toThrow(MatchExplanationValidationError);
  });

  it("throws MatchExplanationValidationError when the tool_use input fails schema validation", async () => {
    await expect(
      generateMatchExplanation(fakeClient({ strongMatches: "not-an-array" }), { ANTHROPIC_MODEL_FAST: "test-model" }, validInput)
    ).rejects.toThrow(MatchExplanationValidationError);
  });

  it("never puts raw job description text in the prompt -- only the structured input fields", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "record_match_explanation", input: validDraft }],
    });
    const client: FakeClient = { messages: { create } as unknown as Anthropic["messages"] };

    await generateMatchExplanation(client, { ANTHROPIC_MODEL_FAST: "test-model" }, validInput);

    const call = create.mock.calls[0][0];
    const serialized = JSON.stringify(call.messages);
    expect(serialized).not.toContain("descriptionText");
    expect(serialized).toContain("Data Engineer");
    expect(serialized).toContain("SQL");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @ai-career/matching test -- generateMatchExplanation`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `generateMatchExplanation`**

`packages/matching/src/explanation/generateMatchExplanation.ts`:
```typescript
import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "@ai-career/config";
import { MatchExplanationSchema, type MatchExplanationDraft } from "./matchExplanationSchema";

const EXPLANATION_TOOL_NAME = "record_match_explanation";

const stringArray = { type: "array", items: { type: "string" } } as const;

const EXPLANATION_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    strongMatches: stringArray,
    partialMatches: stringArray,
    gaps: stringArray,
    summary: { type: "string" },
  },
  required: ["strongMatches", "partialMatches", "gaps", "summary"],
} as const;

export class MatchExplanationValidationError extends Error {}

export interface MatchExplanationInput {
  jobTitle: string;
  companyName: string;
  overallScore: number;
  skillMatches: { skill: string; found: boolean }[];
  experience: { requiredYears: number | null; candidateYears: number | null };
  workMode: { job: string; goal: string };
  sponsorship: { required: boolean | null; job: string };
  salary: { comparable: boolean; withinRange: boolean | null };
  freshnessDays: number;
}

/**
 * Narrates already-computed factor scores into readable prose -- never re-derives or re-scores
 * anything (D6's "LLM explains, doesn't decide" boundary). The prompt carries only the structured
 * `input` fields, never raw job description or resume text, which bounds the prompt-injection
 * surface from untrusted job content without needing per-field nonce handling (design doc §9).
 */
export async function generateMatchExplanation(
  client: Pick<Anthropic, "messages">,
  env: Pick<Env, "ANTHROPIC_MODEL_FAST">,
  input: MatchExplanationInput
): Promise<MatchExplanationDraft> {
  const message = await client.messages.create({
    model: env.ANTHROPIC_MODEL_FAST,
    max_tokens: 1024,
    system:
      `You explain, in plain language, why a job was ranked the way it was for a candidate, using the ` +
      `${EXPLANATION_TOOL_NAME} tool. All facts you may use are already given to you in the input JSON -- ` +
      `never invent a skill, requirement, or number not present there. strongMatches lists what clearly ` +
      `favors this job (e.g. a found skill, a matching work mode). partialMatches lists softer or ` +
      `borderline fits (e.g. slightly under the stated experience). gaps lists what is missing or ` +
      `unfavorable (e.g. a skill marked not found). summary is one or two sentences. Every item must be ` +
      `traceable to a field in the input; if a category has nothing to report, return an empty array.`,
    tools: [
      {
        name: EXPLANATION_TOOL_NAME,
        description: "Record the structured explanation for why a job was ranked the way it was.",
        input_schema: EXPLANATION_TOOL_INPUT_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: EXPLANATION_TOOL_NAME },
    messages: [{ role: "user", content: JSON.stringify(input) }],
  });

  const toolUse = message.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) {
    throw new MatchExplanationValidationError("Anthropic response did not include the expected tool_use block");
  }
  const result = MatchExplanationSchema.safeParse(toolUse.input);
  if (!result.success) {
    throw new MatchExplanationValidationError(`Explanation output failed schema validation: ${result.error.message}`);
  }
  return result.data;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @ai-career/matching test -- generateMatchExplanation`
Expected: PASS.

- [ ] **Step 6: Export and verify**

Add to `packages/matching/src/index.ts`:
```typescript
export * from "./explanation/matchExplanationSchema";
export * from "./explanation/generateMatchExplanation";
```

Run: `pnpm --filter @ai-career/matching typecheck && pnpm --filter @ai-career/matching lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/matching/src/explanation packages/matching/src/index.ts
git commit -m "feat(matching): AI match reasoning -- structured, evidence-grounded explanation generation"
```

### Task 7: `upsertMatch`, `explanationStaleness`, queue constants

**Files:**
- Create: `packages/matching/src/pipeline/upsertMatch.ts`, `packages/matching/src/explanation/explanationStaleness.ts`, `packages/matching/src/queue.ts`
- Test: `upsertMatch.test.ts`, `explanationStaleness.test.ts`

**Interfaces:**
- Consumes: `schema.jobMatches`, `DbClient`, `withUserContext` from `@ai-career/db`; `FactorScores` (Task 1).
- Produces: `ExistingMatchRow`, `upsertMatchRow(tx, input): Promise<void>`; `isExplanationStale(input): boolean`; `MATCHING_QUEUE_NAME`, `MATCHING_JOB_NAME`, `MatchingJobData`, `matchingJobId`, `MATCHING_JOB_OPTIONS` — all consumed by Task 8's pipeline, and the queue constants also by Tasks 9 and 10.

- [ ] **Step 1: Write the failing test for `upsertMatchRow`**

`packages/matching/src/pipeline/upsertMatch.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { schema, withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { upsertMatchRow } from "./upsertMatch";
import type { FactorScores } from "../types";

const USER = "00000000-0000-0000-0000-0000000000e4";
let testDb: TestDb;

const factors: FactorScores = {
  skillsScore: 0.8, experienceScore: 1, locationScore: 1, sponsorshipScore: 1,
  roleScore: 0.9, salaryScore: null, industryScore: 1, freshnessScore: 1, semanticScore: 0.7,
};

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(() => wipeUser(testDb.adminSql, USER));

async function seed() {
  const [goal] = await testDb.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', now(), now()) RETURNING id`;
  return { goalId: goal.id as string, jobId: job.id as string };
}

describe("upsertMatchRow", () => {
  it("inserts a new eligible row with its factor scores and overall score", async () => {
    const { goalId, jobId } = await seed();
    await withUserContext(testDb.db, USER, (tx) =>
      upsertMatchRow(tx, { jobId, careerGoalId: goalId, eligible: true, ineligibleReason: null, factors, overallScore: 87.5, computedAt: new Date(), existing: undefined })
    );
    const [row] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)));
    expect(row.eligible).toBe(true);
    expect(Number(row.overallScore)).toBe(87.5);
    expect(row.salaryScore).toBeNull();
    expect(row.userAction).toBe("none");
  });

  it("inserts an ineligible row with a reason and null scores", async () => {
    const { goalId, jobId } = await seed();
    await withUserContext(testDb.db, USER, (tx) =>
      upsertMatchRow(tx, { jobId, careerGoalId: goalId, eligible: false, ineligibleReason: "Dismissed", factors: null, overallScore: null, computedAt: new Date(), existing: undefined })
    );
    const [row] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)));
    expect(row.eligible).toBe(false);
    expect(row.ineligibleReason).toBe("Dismissed");
    expect(row.overallScore).toBeNull();
  });

  it("overwrites an existing row in place on a second call (no duplicate rows)", async () => {
    const { goalId, jobId } = await seed();
    await withUserContext(testDb.db, USER, (tx) =>
      upsertMatchRow(tx, { jobId, careerGoalId: goalId, eligible: true, ineligibleReason: null, factors, overallScore: 50, computedAt: new Date(), existing: undefined })
    );
    await withUserContext(testDb.db, USER, (tx) =>
      upsertMatchRow(tx, { jobId, careerGoalId: goalId, eligible: true, ineligibleReason: null, factors, overallScore: 90, computedAt: new Date(), existing: undefined })
    );
    const rows = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].overallScore)).toBe(90);
  });

  it("carries forward the prior row's userAction, userActionAt and explanation fields (Refinement #4)", async () => {
    const { goalId, jobId } = await seed();
    const userActionAt = new Date("2026-09-20T00:00:00Z");
    const explanationGeneratedAt = new Date("2026-09-20T01:00:00Z");
    await withUserContext(testDb.db, USER, (tx) =>
      tx.insert(schema.jobMatches).values({
        jobId, careerGoalId: goalId, eligible: true, computedAt: new Date(),
        userAction: "dismissed", userActionAt,
        explanation: { strongMatches: ["x"], partialMatches: [], gaps: [], summary: "s" },
        explanationModel: "test-model", explanationDescriptionHash: "dh", explanationGeneratedAt,
      })
    );
    const [existing] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)));

    await withUserContext(testDb.db, USER, (tx) =>
      upsertMatchRow(tx, { jobId, careerGoalId: goalId, eligible: false, ineligibleReason: "You dismissed this job.", factors: null, overallScore: null, computedAt: new Date(), existing })
    );

    const [row] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)));
    expect(row.userAction).toBe("dismissed");
    expect(row.userActionAt).toEqual(userActionAt);
    expect(row.explanationModel).toBe("test-model");
    expect(row.explanationGeneratedAt).toEqual(explanationGeneratedAt);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ai-career/matching test -- upsertMatch`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `upsertMatchRow`**

`packages/matching/src/pipeline/upsertMatch.ts`:
```typescript
import { eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import type { FactorScores } from "../types";

const { jobMatches } = schema;

export type ExistingMatchRow = typeof jobMatches.$inferSelect;

export interface UpsertMatchRowInput {
  jobId: string;
  careerGoalId: string;
  eligible: boolean;
  ineligibleReason: string | null;
  factors: FactorScores | null;
  overallScore: number | null;
  computedAt: Date;
  /** The row from before this run touched it, if one exists -- Refinement #4 carries its userAction/explanation forward. */
  existing: ExistingMatchRow | undefined;
}

/** One row per (user, job), overwritten in place via the `job_matches_user_job_uniq` index. */
export async function upsertMatchRow(tx: DbClient, input: UpsertMatchRowInput): Promise<void> {
  const carriedForward = {
    userAction: input.existing?.userAction ?? ("none" as const),
    userActionAt: input.existing?.userActionAt ?? null,
    explanation: input.existing?.explanation ?? null,
    explanationModel: input.existing?.explanationModel ?? null,
    explanationDescriptionHash: input.existing?.explanationDescriptionHash ?? null,
    explanationGeneratedAt: input.existing?.explanationGeneratedAt ?? null,
  };
  const values = {
    jobId: input.jobId,
    careerGoalId: input.careerGoalId,
    eligible: input.eligible,
    ineligibleReason: input.ineligibleReason,
    skillsScore: input.factors?.skillsScore ?? null,
    experienceScore: input.factors?.experienceScore ?? null,
    locationScore: input.factors?.locationScore ?? null,
    sponsorshipScore: input.factors?.sponsorshipScore ?? null,
    roleScore: input.factors?.roleScore ?? null,
    salaryScore: input.factors?.salaryScore ?? null,
    industryScore: input.factors?.industryScore ?? null,
    freshnessScore: input.factors?.freshnessScore ?? null,
    semanticScore: input.factors?.semanticScore ?? null,
    overallScore: input.overallScore,
    computedAt: input.computedAt,
    ...carriedForward,
  };
  await tx
    .insert(jobMatches)
    .values(values)
    .onConflictDoUpdate({ target: [jobMatches.userId, jobMatches.jobId], set: values });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @ai-career/matching test -- upsertMatch`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `isExplanationStale`**

`packages/matching/src/explanation/explanationStaleness.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { isExplanationStale, type StalenessInput } from "./explanationStaleness";

const now = new Date("2026-09-22T00:00:00Z");
const fresh: StalenessInput = {
  existing: { careerGoalId: "goal-1", explanationGeneratedAt: new Date("2026-09-20T00:00:00Z"), explanationDescriptionHash: "dh-1" },
  activeCareerGoalId: "goal-1",
  currentDescriptionHash: "dh-1",
  now,
  ttlDays: 7,
};

describe("isExplanationStale", () => {
  it("is stale when there is no existing explanation", () => {
    expect(isExplanationStale({ ...fresh, existing: undefined })).toBe(true);
  });
  it("is not stale when nothing has changed and the TTL has not elapsed", () => {
    expect(isExplanationStale(fresh)).toBe(false);
  });
  it("is stale when the job's description hash changed", () => {
    expect(isExplanationStale({ ...fresh, currentDescriptionHash: "dh-2" })).toBe(true);
  });
  it("is stale when the active career goal changed", () => {
    expect(isExplanationStale({ ...fresh, activeCareerGoalId: "goal-2" })).toBe(true);
  });
  it("is stale once the TTL has elapsed", () => {
    expect(isExplanationStale({ ...fresh, ttlDays: 1 })).toBe(true);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @ai-career/matching test -- explanationStaleness`
Expected: FAIL — module does not exist.

- [ ] **Step 7: Implement `isExplanationStale` and the queue constants**

`packages/matching/src/explanation/explanationStaleness.ts`:
```typescript
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
```

`packages/matching/src/queue.ts` (no `bullmq` dependency, mirrors `packages/ingestion/src/queue.ts` — shared by `services/matching-worker` and the web app's "Find Matches"):
```typescript
export const MATCHING_QUEUE_NAME = "matching";
export const MATCHING_JOB_NAME = "run-matching";

export interface MatchingJobData {
  userId: string;
}

/** A fixed job id per user makes BullMQ ignore a second "Find Matches" click while one run is queued or active. */
export const matchingJobId = (userId: string): string => `matching-${userId}`;

/**
 * Only 2 attempts (vs. ingestion's 3): a retry re-runs the whole pipeline, and every explanation
 * call it repeats is a billed LLM request, not just an idempotent DB write. `upsertMatchRow` and the
 * explanation-staleness check together mean a retry mostly re-uses what the first attempt already
 * wrote, but that "mostly" is why this stays low rather than zero.
 */
export const MATCHING_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: "exponential" as const, delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: true,
};
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm --filter @ai-career/matching test -- explanationStaleness`
Expected: PASS.

- [ ] **Step 9: Export and verify**

Add to `packages/matching/src/index.ts`:
```typescript
export * from "./pipeline/upsertMatch";
export * from "./explanation/explanationStaleness";
export * from "./queue";
```

Run: `pnpm --filter @ai-career/matching typecheck && pnpm --filter @ai-career/matching lint && pnpm --filter @ai-career/matching test`
Expected: all clean.

- [ ] **Step 10: Commit**

```bash
git add packages/matching/src/pipeline/upsertMatch.ts packages/matching/src/explanation/explanationStaleness.ts \
        packages/matching/src/queue.ts packages/matching/src/index.ts
git commit -m "feat(matching): match-row upsert, explanation staleness, matching queue constants"
```

### Task 8: `runMatching` — pipeline orchestration

**Files:**
- Modify: `packages/config/src/env.ts`, `packages/config/src/env.test.ts`
- Create: `packages/matching/src/pipeline/runMatching.ts`
- Test: `packages/matching/src/pipeline/runMatching.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7 (`evaluateEligibility`, every `score*` function, `computeOverallScore`, `ensureGoalEmbedding`, `ensureJobEmbeddings`, `fetchCandidateJobs`, `generateMatchExplanation`, `MatchExplanationValidationError`, `isExplanationStale`, `upsertMatchRow`, `ExistingMatchRow`).
- Produces: `MatchingErrorClass`, `MatchingError`, `RunMatchingOptions`, `MatchingRunSummary`, `runMatching(db, opts): Promise<MatchingRunSummary>` — consumed by Task 9's worker.

- [ ] **Step 1: Add the matching env vars**

In `packages/config/src/env.ts`, add after `INGEST_INTERVAL_MINUTES`:
```typescript
    // Phase 5 matching. All tunable, none yet backed by labeled data (design doc §10).
    MATCHING_EXPLAIN_TOP_N: z.coerce.number().int().min(1).max(200).default(25),
    MATCHING_EXPERIENCE_GRACE_YEARS: z.coerce.number().min(0).max(10).default(1),
    MATCHING_FRESHNESS_HALF_LIFE_HOURS: z.coerce.number().min(1).default(168),
    MATCHING_EXPLANATION_TTL_DAYS: z.coerce.number().min(1).default(7),
```

In `packages/config/src/env.test.ts`, add a new test after `"rejects a too-short ingestion interval..."`:
```typescript
  it("defaults the matching settings and lets them be overridden", () => {
    const env = loadEnv(validSource);
    expect(env.MATCHING_EXPLAIN_TOP_N).toBe(25);
    expect(env.MATCHING_EXPERIENCE_GRACE_YEARS).toBe(1);
    expect(env.MATCHING_FRESHNESS_HALF_LIFE_HOURS).toBe(168);
    expect(env.MATCHING_EXPLANATION_TTL_DAYS).toBe(7);

    const custom = loadEnv({ ...validSource, MATCHING_EXPLAIN_TOP_N: "10" });
    expect(custom.MATCHING_EXPLAIN_TOP_N).toBe(10);
  });
```

Run: `pnpm --filter @ai-career/config test`
Expected: PASS.

- [ ] **Step 2: Write the failing integration test for `runMatching`**

`packages/matching/src/pipeline/runMatching.test.ts`:
```typescript
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { schema, withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { runMatching, MatchingError } from "./runMatching";
import { MatchExplanationValidationError } from "../explanation/generateMatchExplanation";

vi.mock("@ai-career/ai", () => ({ embedTexts: vi.fn().mockResolvedValue([]) }));
import { embedTexts } from "@ai-career/ai";

const USER = "00000000-0000-0000-0000-0000000000e5";
let testDb: TestDb;

const ENV = {
  ANTHROPIC_MODEL_FAST: "test-model",
  EMBEDDING_PROVIDER: "voyage" as const,
  VOYAGE_API_KEY: "k",
  VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
  MATCHING_EXPLAIN_TOP_N: 1,
  MATCHING_EXPERIENCE_GRACE_YEARS: 1,
  MATCHING_FRESHNESS_HALF_LIFE_HOURS: 168,
  MATCHING_EXPLANATION_TTL_DAYS: 7,
};

function fakeAnthropic(explanation: unknown = { strongMatches: ["x"], partialMatches: [], gaps: [], summary: "s" }): Pick<Anthropic, "messages"> {
  return { messages: { create: async () => ({ content: [{ type: "tool_use", id: "t1", name: "record_match_explanation", input: explanation }] }) } as unknown as Anthropic["messages"] };
}

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  vi.mocked(embedTexts).mockReset().mockResolvedValue([]);
  await wipeUser(testDb.adminSql, USER);
});

async function seedGoalAndProfile(): Promise<string> {
  const [goal] = await testDb.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER}, 'Data roles', 1, 'parsed', 'confirmed', true) RETURNING id`;
  await testDb.adminSql`
    INSERT INTO career_goal_constraints (user_id, career_goal_id, target_roles, skills, work_mode)
    VALUES (${USER}, ${goal.id}, ARRAY['Data Engineer'], ARRAY['SQL'], 'any')`;
  await testDb.adminSql`
    INSERT INTO candidate_profiles (user_id, full_name, email, years_of_experience)
    VALUES (${USER}, 'Test User', 't@example.com', 5)`;
  return goal.id as string;
}

async function seedJob(opts: { title: string; companyName?: string }): Promise<string> {
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_text, description_hash,
                       status, first_seen_at, last_verified_at)
    VALUES (${USER}, ${opts.companyName ?? "Acme"}, ${(opts.companyName ?? "Acme").toLowerCase()}, ${opts.title}, 'title-key',
            'We use SQL daily.', ${"hash-" + opts.title}, 'open', now(), now())
    RETURNING id`;
  return job.id as string;
}

describe("runMatching", () => {
  it("throws MatchingError('no_active_goal') and records a failed run when there is no confirmed active goal", async () => {
    await expect(
      runMatching(testDb.db, { userId: USER, anthropicClient: fakeAnthropic(), env: ENV })
    ).rejects.toMatchObject({ errorClass: "no_active_goal" });
  });

  it("scores eligible jobs, excludes ineligible ones with a reason, and explains only the top N", async () => {
    await seedGoalAndProfile();
    await seedJob({ title: "Data Engineer" });
    await seedJob({ title: "Data Analyst" });
    await seedJob({ title: "Excluded Role", companyName: "Excluded Co" });
    await withUserContext(testDb.db, USER, (tx) =>
      tx.update(schema.careerGoalConstraints).set({ excludedCompanies: ["Excluded Co"] })
    );

    const summary = await runMatching(testDb.db, { userId: USER, anthropicClient: fakeAnthropic(), env: ENV });

    expect(summary.status).toBe("completed");
    expect(summary.jobsEvaluated).toBe(3);
    expect(summary.jobsEligible).toBe(2);
    expect(summary.jobsExplained).toBe(1); // MATCHING_EXPLAIN_TOP_N: 1

    const rows = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches));
    const excluded = rows.find((r) => r.ineligibleReason?.includes("Excluded"));
    expect(excluded?.eligible).toBe(false);
    expect(rows.filter((r) => r.eligible)).toHaveLength(2);
    expect(rows.filter((r) => r.explanation !== null)).toHaveLength(1);

    const [run] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.matchingRuns));
    expect(run.status).toBe("completed");
    expect(run.jobsEligible).toBe(2);
  });

  it("keeps a dismissed job ineligible on the next run and carries its userAction forward", async () => {
    await seedGoalAndProfile();
    const jobId = await seedJob({ title: "Data Engineer" });
    await runMatching(testDb.db, { userId: USER, anthropicClient: fakeAnthropic(), env: { ...ENV, MATCHING_EXPLAIN_TOP_N: 0 } });
    await testDb.adminSql`UPDATE job_matches SET user_action = 'dismissed', user_action_at = now() WHERE job_id = ${jobId}`;

    await runMatching(testDb.db, { userId: USER, anthropicClient: fakeAnthropic(), env: ENV });

    const rows = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches));
    const dismissed = rows.find((r) => r.jobId === jobId)!;
    expect(dismissed.eligible).toBe(false);
    expect(dismissed.userAction).toBe("dismissed");
  });

  it("does not fail the run when one explanation response is malformed -- the job keeps its scores", async () => {
    await seedGoalAndProfile();
    await seedJob({ title: "Data Engineer" });
    const badClient = fakeAnthropic({ strongMatches: "not-an-array" });

    const summary = await runMatching(testDb.db, { userId: USER, anthropicClient: badClient, env: ENV });

    expect(summary.status).toBe("completed");
    expect(summary.jobsExplained).toBe(0);
    const rows = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches));
    expect(rows[0].eligible).toBe(true);
    expect(rows[0].explanation).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @ai-career/matching test -- runMatching`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `runMatching`**

`packages/matching/src/pipeline/runMatching.ts`:
```typescript
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { evaluateEligibility } from "../eligibility/evaluateEligibility";
import { scoreSkills } from "../scoring/scoreSkills";
import { scoreExperience } from "../scoring/scoreExperience";
import { scoreLocation } from "../scoring/scoreLocation";
import { scoreSponsorship } from "../scoring/scoreSponsorship";
import { scoreRole } from "../scoring/scoreRole";
import { scoreSalary } from "../scoring/scoreSalary";
import { scoreIndustry } from "../scoring/scoreIndustry";
import { scoreFreshness } from "../scoring/scoreFreshness";
import { scoreSemantic } from "../scoring/scoreSemantic";
import { computeOverallScore } from "../scoring/computeOverallScore";
import { ensureGoalEmbedding } from "../embeddings/ensureGoalEmbedding";
import { ensureJobEmbeddings } from "../embeddings/ensureJobEmbeddings";
import { fetchCandidateJobs, type CandidateJobRow } from "../retrieval/fetchCandidateJobs";
import { generateMatchExplanation, MatchExplanationValidationError } from "../explanation/generateMatchExplanation";
import { isExplanationStale } from "../explanation/explanationStaleness";
import { upsertMatchRow, type ExistingMatchRow } from "./upsertMatch";
import type { FactorScores } from "../types";

const { careerGoals, careerGoalConstraints, candidateProfiles, jobMatches, matchingRuns } = schema;
const MS_PER_DAY = 86_400_000;
const num = (value: string | null): number | null => (value === null ? null : Number(value));

export type MatchingErrorClass = "no_active_goal" | "unknown";

export class MatchingError extends Error {
  readonly errorClass: MatchingErrorClass;
  constructor(errorClass: MatchingErrorClass) {
    super(errorClass);
    this.name = "MatchingError";
    this.errorClass = errorClass;
  }
}

export interface RunMatchingEnv {
  ANTHROPIC_MODEL_FAST: string;
  EMBEDDING_PROVIDER: "voyage" | "self-hosted";
  VOYAGE_API_KEY?: string;
  VOYAGE_EMBEDDING_MODEL: string;
  MATCHING_EXPLAIN_TOP_N: number;
  MATCHING_EXPERIENCE_GRACE_YEARS: number;
  MATCHING_FRESHNESS_HALF_LIFE_HOURS: number;
  MATCHING_EXPLANATION_TTL_DAYS: number;
}

export interface RunMatchingOptions {
  userId: string;
  anthropicClient: Pick<Anthropic, "messages">;
  env: RunMatchingEnv;
  now?: () => Date;
}

export interface MatchingRunSummary {
  runId: string;
  status: "completed" | "failed";
  errorClass: MatchingErrorClass | null;
  jobsEvaluated: number;
  jobsEligible: number;
  jobsExplained: number;
}

interface ScoredJob {
  jobId: string;
  job: CandidateJobRow;
  factors: FactorScores;
  overallScore: number;
  skillMatches: { skill: string; found: boolean }[];
}

/**
 * One guard -> ensure embeddings -> eligibility+score every open job -> explain the top N -> finalize
 * cycle for a user's active career goal. Throws `MatchingError` (a class only) when the run fails,
 * after recording it -- same shape as packages/ingestion's `runIngestion`.
 */
export async function runMatching(db: DbClient, opts: RunMatchingOptions): Promise<MatchingRunSummary> {
  const { userId, env, anthropicClient } = opts;
  const now = opts.now ?? (() => new Date());
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, userId, fn);

  const [goal] = await inUserContext((tx) =>
    tx
      .select({ id: careerGoals.id })
      .from(careerGoals)
      .where(and(eq(careerGoals.isActive, true), eq(careerGoals.confirmationStatus, "confirmed")))
      .limit(1)
  );
  if (!goal) throw new MatchingError("no_active_goal");

  const startedAt = now();
  const [run] = await inUserContext((tx) =>
    tx.insert(matchingRuns).values({ careerGoalId: goal.id, startedAt }).returning({ id: matchingRuns.id })
  );

  const counters = { evaluated: 0, eligible: 0, explained: 0 };
  const finish = (status: "completed" | "failed", errorClass: MatchingErrorClass | null) =>
    inUserContext((tx) =>
      tx
        .update(matchingRuns)
        .set({
          finishedAt: now(),
          status,
          errorClass,
          jobsEvaluated: counters.evaluated,
          jobsEligible: counters.eligible,
          jobsExplained: counters.explained,
        })
        .where(eq(matchingRuns.id, run.id))
    );

  try {
    const [constraints] = await inUserContext((tx) =>
      tx.select().from(careerGoalConstraints).where(eq(careerGoalConstraints.careerGoalId, goal.id)).limit(1)
    );
    if (!constraints) throw new MatchingError("no_active_goal");

    const [profile] = await inUserContext((tx) =>
      tx.select({ yearsOfExperience: candidateProfiles.yearsOfExperience }).from(candidateProfiles).limit(1)
    );
    const candidateYears = profile?.yearsOfExperience ?? null;

    const goalEmbedding = await inUserContext((tx) => ensureGoalEmbedding(tx, env, constraints.id));

    const initialRows = await inUserContext((tx) => fetchCandidateJobs(tx, goalEmbedding));
    await inUserContext((tx) => ensureJobEmbeddings(tx, env, initialRows.map((r) => r.id)));
    // Re-fetch so a job embedded just now is reflected in this run's semantic similarity.
    const rows = goalEmbedding ? await inUserContext((tx) => fetchCandidateJobs(tx, goalEmbedding)) : initialRows;

    const existingRows = await inUserContext((tx) => tx.select().from(jobMatches));
    const existingByJobId = new Map<string, ExistingMatchRow>(existingRows.map((r) => [r.jobId, r]));

    const scored: ScoredJob[] = [];

    for (const job of rows) {
      counters.evaluated++;
      const existing = existingByJobId.get(job.id);
      const eligibility = evaluateEligibility({
        companyName: job.companyName,
        jobWorkMode: job.workMode,
        jobMinExperienceYears: job.minExperienceYears,
        jobSponsorship: job.sponsorship,
        excludedCompanies: constraints.excludedCompanies,
        excludedIndustries: constraints.excludedIndustries,
        constraintsWorkMode: constraints.workMode,
        visaSponsorshipRequired: constraints.visaSponsorshipRequired,
        candidateYearsOfExperience: candidateYears,
        experienceGraceYears: env.MATCHING_EXPERIENCE_GRACE_YEARS,
        previouslyDismissed: existing?.userAction === "dismissed",
      });

      if (!eligibility.eligible) {
        await inUserContext((tx) =>
          upsertMatchRow(tx, {
            jobId: job.id, careerGoalId: goal.id, eligible: false, ineligibleReason: eligibility.reason,
            factors: null, overallScore: null, computedAt: now(), existing,
          })
        );
        continue;
      }
      counters.eligible++;

      const skills = scoreSkills(constraints.skills, job.title, job.descriptionText, job.semanticSimilarity);
      const factors: FactorScores = {
        skillsScore: skills.score,
        experienceScore: scoreExperience(job.minExperienceYears, candidateYears, env.MATCHING_EXPERIENCE_GRACE_YEARS),
        locationScore: scoreLocation(job.workMode, constraints.workMode, job.locationRaw, job.countryCode, constraints.locations),
        sponsorshipScore: scoreSponsorship(constraints.visaSponsorshipRequired, job.sponsorship),
        roleScore: scoreRole(constraints.targetRoles, job.title),
        salaryScore: scoreSalary({
          jobMin: job.salaryMin, jobMax: job.salaryMax, jobCurrency: job.salaryCurrency, jobIsParsed: job.salaryIsParsed,
          floorNormalized: num(constraints.salaryFloorNormalized), floorCurrency: constraints.salaryCurrency, floorIsParsed: constraints.salaryIsParsed,
          targetNormalized: num(constraints.salaryTargetNormalized), targetCurrency: constraints.salaryTargetCurrency, targetIsParsed: constraints.salaryTargetIsParsed,
        }),
        industryScore: scoreIndustry(job.companyName, constraints.preferredIndustries),
        freshnessScore: scoreFreshness(job.postedAt, job.firstSeenAt, env.MATCHING_FRESHNESS_HALF_LIFE_HOURS, now()),
        semanticScore: scoreSemantic(job.semanticSimilarity),
      };
      const overallScore = computeOverallScore(factors);

      await inUserContext((tx) =>
        upsertMatchRow(tx, {
          jobId: job.id, careerGoalId: goal.id, eligible: true, ineligibleReason: null,
          factors, overallScore, computedAt: now(), existing,
        })
      );
      scored.push({ jobId: job.id, job, factors, overallScore, skillMatches: skills.matches });
    }

    scored.sort((a, b) => b.overallScore - a.overallScore);
    const stale = scored.filter((s) =>
      isExplanationStale({
        existing: existingByJobId.get(s.jobId),
        activeCareerGoalId: goal.id,
        currentDescriptionHash: s.job.descriptionHash,
        now: now(),
        ttlDays: env.MATCHING_EXPLANATION_TTL_DAYS,
      })
    );
    const toExplain = stale.slice(0, env.MATCHING_EXPLAIN_TOP_N);

    for (const item of toExplain) {
      try {
        const referenceDate = item.job.postedAt ?? item.job.firstSeenAt;
        const draft = await generateMatchExplanation(anthropicClient, env, {
          jobTitle: item.job.title,
          companyName: item.job.companyName,
          overallScore: item.overallScore,
          skillMatches: item.skillMatches,
          experience: { requiredYears: item.job.minExperienceYears, candidateYears },
          workMode: { job: item.job.workMode, goal: constraints.workMode },
          sponsorship: { required: constraints.visaSponsorshipRequired, job: item.job.sponsorship },
          salary: { comparable: item.factors.salaryScore !== null, withinRange: item.factors.salaryScore === null ? null : item.factors.salaryScore >= 0.6 },
          freshnessDays: Math.round((now().getTime() - referenceDate.getTime()) / MS_PER_DAY),
        });
        await inUserContext((tx) =>
          tx
            .update(jobMatches)
            .set({ explanation: draft, explanationModel: env.ANTHROPIC_MODEL_FAST, explanationDescriptionHash: item.job.descriptionHash, explanationGeneratedAt: now() })
            .where(eq(jobMatches.jobId, item.jobId))
        );
        counters.explained++;
      } catch (error) {
        // A malformed response leaves the row's deterministic scores intact -- never blocks the run.
        // Anything else (e.g. a network error) is unexpected and does fail the run, same as
        // runIngestion's "anything not IngestError is wrapped as unknown" rule.
        if (!(error instanceof MatchExplanationValidationError)) throw error;
      }
    }

    await finish("completed", null);
    return { runId: run.id, status: "completed", errorClass: null, jobsEvaluated: counters.evaluated, jobsEligible: counters.eligible, jobsExplained: counters.explained };
  } catch (error) {
    const failure = error instanceof MatchingError ? error : new MatchingError("unknown");
    await finish("failed", failure.errorClass).catch(() => undefined);
    throw failure;
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @ai-career/matching test -- runMatching`
Expected: PASS.

- [ ] **Step 6: Export and verify the whole package**

Add to `packages/matching/src/index.ts`: `export * from "./pipeline/runMatching";`

Run: `pnpm --filter @ai-career/matching typecheck && pnpm --filter @ai-career/matching lint && pnpm --filter @ai-career/matching test`
Expected: all clean, full suite green.

- [ ] **Step 7: Commit**

```bash
git add packages/config/src/env.ts packages/config/src/env.test.ts packages/matching/src/pipeline/runMatching.ts packages/matching/src/index.ts
git commit -m "feat(matching): runMatching pipeline orchestration + matching env vars"
```

### Task 9: `services/matching-worker` — BullMQ worker + entrypoint

**Files:**
- Create: `services/matching-worker/package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`
- Create: `services/matching-worker/src/worker.ts`, `services/matching-worker/src/main.ts`
- Test: `services/matching-worker/src/worker.test.ts`

**Interfaces:**
- Consumes: `MATCHING_QUEUE_NAME`, `MatchingJobData`, `MatchingError`, `runMatching`, `RunMatchingEnv` from `@ai-career/matching`; `createAnthropicClient` from `@ai-career/ai`.
- Produces: `createMatchingWorker(deps): Worker<MatchingJobData>` — consumed by `main.ts` and by Task 10's enqueue tests (as a pattern reference, not an import).

No scheduler/reconcile module here (unlike `services/job-ingestion`): matching only ever runs on an explicit "Find Matches" enqueue (design doc decision #6, no auto-trigger), so there is nothing to reconcile on a timer.

- [ ] **Step 1: Scaffold the service**

`services/matching-worker/package.json`:
```json
{
  "name": "@ai-career/matching-worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "dotenv -e ../../.env -- tsx src/main.ts",
    "dev": "dotenv -e ../../.env -- tsx watch src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@ai-career/ai": "workspace:*",
    "@ai-career/config": "workspace:*",
    "@ai-career/db": "workspace:*",
    "@ai-career/matching": "workspace:*",
    "@anthropic-ai/sdk": "^0.32.1",
    "bullmq": "^5.34.0",
    "drizzle-orm": "^0.36.0",
    "ioredis": "^5.4.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "dotenv-cli": "^7.4.0",
    "eslint": "^9.0.0",
    "postgres": "^3.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```

`services/matching-worker/tsconfig.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`services/matching-worker/vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
```

`services/matching-worker/eslint.config.mjs`:
```javascript
import baseConfig from "../../eslint.config.base.mjs";

export default baseConfig;
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing worker test**

`services/matching-worker/src/worker.test.ts`:
```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, type Worker } from "bullmq";
import type Anthropic from "@anthropic-ai/sdk";
import { openTestDb, wipeUser, type TestDb } from "@ai-career/matching/testing";
import { MATCHING_JOB_NAME, matchingJobId, type MatchingJobData, type RunMatchingEnv } from "@ai-career/matching";
import { createMatchingWorker } from "./worker";

const USER = "00000000-0000-0000-0000-0000000000a9";
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), maxRetriesPerRequest: null };
const queueName = `matching-test-${randomUUID()}`;

const ENV: RunMatchingEnv = {
  ANTHROPIC_MODEL_FAST: "test-model", EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "k", VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
  MATCHING_EXPLAIN_TOP_N: 0, MATCHING_EXPERIENCE_GRACE_YEARS: 1, MATCHING_FRESHNESS_HALF_LIFE_HOURS: 168, MATCHING_EXPLANATION_TTL_DAYS: 7,
};
const anthropicClient: Pick<Anthropic, "messages"> = { messages: { create: vi.fn() } as unknown as Anthropic["messages"] };

let t: TestDb;
let queue: Queue<MatchingJobData>;
let events: QueueEvents;
let worker: Worker<MatchingJobData>;

beforeAll(async () => {
  t = await openTestDb();
  queue = new Queue<MatchingJobData>(queueName, { connection });
  events = new QueueEvents(queueName, { connection });
  await events.waitUntilReady();
  worker = createMatchingWorker({ connection, db: t.db, anthropicClient, env: ENV, queueName });
  await worker.waitUntilReady();
});
beforeEach(() => wipeUser(t.adminSql, USER));
afterAll(async () => {
  await worker.close();
  await events.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await wipeUser(t.adminSql, USER);
  await t.close();
});

const enqueue = (userId: string, opts: Record<string, unknown> = {}) =>
  queue.add(MATCHING_JOB_NAME, { userId }, { jobId: matchingJobId(userId), ...opts });

describe("matching worker", () => {
  it("runs an enqueued user's matching pass end to end", async () => {
    const [goal] = await t.adminSql`
      INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
      VALUES (${USER}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
    await t.adminSql`INSERT INTO career_goal_constraints (user_id, career_goal_id) VALUES (${USER}, ${goal.id})`;
    await t.adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, status, first_seen_at, last_verified_at)
      VALUES (${USER}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', 'open', now(), now())`;

    await (await enqueue(USER)).waitUntilFinished(events);

    const runs = await t.adminSql`SELECT status FROM matching_runs WHERE user_id = ${USER}`;
    expect(runs).toEqual([{ status: "completed" }]);
  });

  it("does not retry a permanent failure (no active career goal)", async () => {
    const job = await enqueue(USER, { attempts: 3, backoff: { type: "fixed", delay: 10 }, removeOnFail: false });
    await expect(job.waitUntilFinished(events)).rejects.toThrow("no_active_goal");
    expect(await job.getState()).toBe("failed");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @ai-career/matching-worker test`
Expected: FAIL — `worker.ts` does not exist.

- [ ] **Step 4: Implement the worker**

`services/matching-worker/src/worker.ts`:
```typescript
import { Worker, UnrecoverableError, type ConnectionOptions } from "bullmq";
import type Anthropic from "@anthropic-ai/sdk";
import type { DbClient } from "@ai-career/db";
import { MATCHING_QUEUE_NAME, MatchingError, runMatching, type MatchingJobData, type RunMatchingEnv } from "@ai-career/matching";

export interface MatchingWorkerDeps {
  connection: ConnectionOptions;
  db: DbClient;
  anthropicClient: Pick<Anthropic, "messages">;
  env: RunMatchingEnv;
  /** Overridable so tests use an isolated queue. */
  queueName?: string;
}

/**
 * Holds no domain logic: hands the user id to `runMatching` and maps its error class onto BullMQ's
 * retry model. "no_active_goal" would fail identically on every retry, so it is unrecoverable;
 * anything else (network, an unexpected exception) may be transient and gets the queue's backoff.
 * Concurrency 1, same rationale as the ingestion worker: this is a personal tool, one run at a time.
 */
export function createMatchingWorker(deps: MatchingWorkerDeps): Worker<MatchingJobData> {
  return new Worker<MatchingJobData>(
    deps.queueName ?? MATCHING_QUEUE_NAME,
    async (job) => {
      try {
        await runMatching(deps.db, { userId: job.data.userId, anthropicClient: deps.anthropicClient, env: deps.env });
      } catch (error) {
        if (error instanceof MatchingError && error.errorClass === "no_active_goal") {
          throw new UnrecoverableError(error.errorClass);
        }
        throw error;
      }
    },
    { connection: deps.connection, concurrency: 1 }
  );
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @ai-career/matching-worker test`
Expected: PASS. (Requires local Postgres/Redis up.)

- [ ] **Step 6: Write the entrypoint**

`services/matching-worker/src/main.ts`:
```typescript
import IORedis from "ioredis";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { createAnthropicClient } from "@ai-career/ai";
import { createMatchingWorker } from "./worker";

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));

const safeErrorLabel = (error: unknown): string =>
  error instanceof Error && (error.name === "UnrecoverableError" || error.name === "MatchingError")
    ? error.message
    : error instanceof Error
      ? error.name
      : "unknown";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const anthropicClient = createAnthropicClient(env);

  const worker = createMatchingWorker({ connection, db, anthropicClient, env });
  worker.on("completed", (job) => log("matching_completed", { jobId: job.id }));
  worker.on("failed", (job, error) => log("matching_failed", { jobId: job?.id, error: safeErrorLabel(error) }));
  log("worker_started", {});

  const shutdown = async () => {
    await worker.close();
    await connection.quit();
    await closeDbClient(db);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log("worker_crashed", { error: safeErrorLabel(error) });
  process.exit(1);
});
```

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm --filter @ai-career/matching-worker typecheck && pnpm --filter @ai-career/matching-worker lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add services/matching-worker pnpm-lock.yaml
git commit -m "feat(matching-worker): BullMQ worker and entrypoint for on-demand matching runs"
```

### Task 10: Web — enqueue helper, test DB helpers, `POST /api/matches/run`

**Files:**
- Modify: `apps/web/src/test/jobsDb.ts`
- Create: `apps/web/src/lib/matching/enqueue.ts`
- Create: `apps/web/src/app/api/matches/run/route.ts`
- Test: `apps/web/src/app/api/matches/run/route.test.ts`

**Interfaces:**
- Consumes: `MATCHING_QUEUE_NAME`, `MATCHING_JOB_NAME`, `MATCHING_JOB_OPTIONS`, `matchingJobId`, `MatchingJobData` from `@ai-career/matching`.
- Produces: `enqueueMatching(env, userId, queueName?): Promise<"enqueued" | "already_queued">`; `insertCareerGoal`, `insertMatch`, `wipeMatchingData` test helpers used by Tasks 11–12's route tests.

- [ ] **Step 1: Extend the shared test DB helper**

Add to `apps/web/src/test/jobsDb.ts` (after `wipeJobData`):
```typescript
/** Also wipes the tables wipeJobData already covers, plus the matching-specific ones. */
export async function wipeMatchingData(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM job_matches WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM matching_runs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM career_goals WHERE user_id = ${userId}`;
  await wipeJobData(adminSql, userId);
}

export async function insertCareerGoal(
  adminSql: postgres.Sql,
  userId: string,
  opts: { isActive?: boolean; confirmationStatus?: "draft" | "confirmed" } = {}
): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${userId}, 'Data roles', 1, 'parsed', ${opts.confirmationStatus ?? "confirmed"}, ${opts.isActive ?? true})
    RETURNING id`;
  return row.id as string;
}

export async function insertMatch(
  adminSql: postgres.Sql,
  userId: string,
  jobId: string,
  careerGoalId: string,
  opts: {
    eligible?: boolean;
    ineligibleReason?: string | null;
    overallScore?: number | null;
    skillsScore?: number | null;
    explanation?: object | null;
    userAction?: "none" | "saved" | "dismissed";
  } = {}
): Promise<string> {
  const eligible = opts.eligible ?? true;
  const [row] = await adminSql`
    INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, ineligible_reason, overall_score, skills_score,
                              explanation, user_action, computed_at)
    VALUES (${userId}, ${jobId}, ${careerGoalId}, ${eligible}, ${opts.ineligibleReason ?? null},
            ${eligible ? (opts.overallScore ?? 75) : null}, ${eligible ? (opts.skillsScore ?? 0.8) : null},
            ${opts.explanation ? JSON.stringify(opts.explanation) : null}::jsonb, ${opts.userAction ?? "none"}, now())
    RETURNING id`;
  return row.id as string;
}
```

- [ ] **Step 2: Write the enqueue helper (no failing test first -- it is a near-exact mirror of the already-tested `enqueueIngestion`; its behavior is exercised end to end by this task's route test)**

`apps/web/src/lib/matching/enqueue.ts`:
```typescript
import IORedis from "ioredis";
import { Queue } from "bullmq";
import {
  MATCHING_JOB_NAME,
  MATCHING_JOB_OPTIONS,
  MATCHING_QUEUE_NAME,
  matchingJobId,
  type MatchingJobData,
} from "@ai-career/matching";

export type EnqueueResult = "enqueued" | "already_queued";

const PENDING_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);
const ENQUEUE_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 1000;

/** Fixed message on purpose: driver errors carry the Redis host and port, which callers must never echo. */
const unavailable = () => new Error("queue unavailable");

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Mirrors `enqueueIngestion` exactly (same queue-producer failure-mode requirements); see its docstring. */
export async function enqueueMatching(
  env: { REDIS_URL: string },
  userId: string,
  queueName: string = MATCHING_QUEUE_NAME
): Promise<EnqueueResult> {
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
    retryStrategy: () => null,
  });
  const queue = new Queue<MatchingJobData>(queueName, { connection });
  connection.on("error", () => undefined);
  queue.on("error", () => undefined);
  try {
    return await withTimeout(push(queue, userId), ENQUEUE_TIMEOUT_MS, unavailable);
  } catch {
    throw unavailable();
  } finally {
    await withTimeout(queue.close(), CLOSE_TIMEOUT_MS, unavailable).catch(() => undefined);
    connection.disconnect();
  }
}

async function push(queue: Queue<MatchingJobData>, userId: string): Promise<EnqueueResult> {
  const existing = await queue.getJob(matchingJobId(userId));
  if (existing && PENDING_STATES.has(await existing.getState())) return "already_queued";
  await queue.add(MATCHING_JOB_NAME, { userId }, { ...MATCHING_JOB_OPTIONS, jobId: matchingJobId(userId) });
  return "enqueued";
}
```

- [ ] **Step 3: Write the failing route test**

`apps/web/src/app/api/matches/run/route.test.ts`:
```typescript
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertCareerGoal } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000c1",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379",
  }),
}));
vi.mock("../../../../lib/matching/enqueue", () => ({ enqueueMatching: vi.fn() }));
import { enqueueMatching } from "../../../../lib/matching/enqueue";

const USER = "00000000-0000-0000-0000-0000000000c1";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  vi.mocked(enqueueMatching).mockReset().mockResolvedValue("enqueued");
  await wipeMatchingData(admin, USER);
});
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { POST } = await import("./route");
const run = () => POST(new Request("http://localhost/api/matches/run", { method: "POST" }));

describe("POST /api/matches/run", () => {
  it("queues a run when a confirmed active career goal exists and answers 202", async () => {
    await insertCareerGoal(admin, USER);
    const res = await run();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "queued" });
    expect(enqueueMatching).toHaveBeenCalledWith(expect.objectContaining({ REDIS_URL: "redis://localhost:6379" }), USER);
  });

  it("answers 409 without queueing when there is no confirmed active career goal", async () => {
    const res = await run();
    expect(res.status).toBe(409);
    expect(enqueueMatching).not.toHaveBeenCalled();
  });

  it("answers 409 without queueing when the only goal is a draft", async () => {
    await insertCareerGoal(admin, USER, { confirmationStatus: "draft", isActive: false });
    const res = await run();
    expect(res.status).toBe(409);
    expect(enqueueMatching).not.toHaveBeenCalled();
  });

  it("answers 409 when a run is already queued or active", async () => {
    vi.mocked(enqueueMatching).mockResolvedValue("already_queued");
    await insertCareerGoal(admin, USER);
    const res = await run();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already queued or running/);
  });

  it("answers 503 with a fixed message when the queue is unavailable, never echoing the error", async () => {
    vi.mocked(enqueueMatching).mockRejectedValue(new Error("ECONNREFUSED secret-host:6379"));
    await insertCareerGoal(admin, USER);
    const res = await run();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "The job queue is unavailable. Is Redis running?" });
    expect(text).not.toContain("secret-host");
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter web test -- matches/run`
Expected: FAIL — `route.ts` does not exist.

- [ ] **Step 5: Implement the route**

`apps/web/src/app/api/matches/run/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { enqueueMatching } from "../../../../lib/matching/enqueue";

export async function POST(_request: Request) {
  const env = loadEnv();
  const db = createDbClient(env);
  let hasActiveGoal: boolean;
  try {
    const rows = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx
        .select({ id: schema.careerGoals.id })
        .from(schema.careerGoals)
        .where(and(eq(schema.careerGoals.isActive, true), eq(schema.careerGoals.confirmationStatus, "confirmed")))
        .limit(1)
    );
    hasActiveGoal = rows.length > 0;
  } finally {
    await closeDbClient(db);
  }
  if (!hasActiveGoal) {
    return NextResponse.json({ error: "Confirm a career goal before finding matches" }, { status: 409 });
  }

  let result;
  try {
    result = await enqueueMatching(env, env.DEFAULT_USER_ID);
  } catch {
    return NextResponse.json({ error: "The job queue is unavailable. Is Redis running?" }, { status: 503 });
  }
  if (result === "already_queued") {
    return NextResponse.json({ error: "A matching run is already queued or running" }, { status: 409 });
  }
  return NextResponse.json({ status: "queued" }, { status: 202 });
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm --filter web test -- matches/run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/test/jobsDb.ts apps/web/src/lib/matching/enqueue.ts apps/web/src/app/api/matches
git commit -m "feat(web): enqueue helper and POST /api/matches/run"
```

### Task 11: Web — match serialization, `GET /api/matches`, `GET`+`PATCH /api/matches/[jobId]`, `GET /api/matches/runs/latest`

**Files:**
- Create: `apps/web/src/lib/matching/serializeMatch.ts`, `apps/web/src/lib/matching/listMatches.ts`, `apps/web/src/lib/matching/matchActionSchema.ts`
- Create: `apps/web/src/app/api/matches/route.ts`, `apps/web/src/app/api/matches/[jobId]/route.ts`, `apps/web/src/app/api/matches/runs/latest/route.ts`
- Test: one `.test.ts` per route above

**Interfaces:**
- Consumes: `getJobDetail`, `JobDetail` from `apps/web/src/lib/jobs/getJobDetail.ts` (Phase 4); `schema.jobMatches`, `schema.matchingRuns`.
- Produces: `MatchView`, `toMatchView(row)`; `MatchListItem`, `ListMatchesQuerySchema`, `listMatches(tx, query)`; `MatchActionSchema` — all consumed only within `apps/web` (Tasks 13/14's pages).

- [ ] **Step 1: Write `serializeMatch.ts`**

`apps/web/src/lib/matching/serializeMatch.ts`:
```typescript
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
    explanation: (row.explanation as MatchExplanationView | null) ?? null,
    userAction: row.userAction,
    computedAt: row.computedAt.toISOString(),
  };
}
```

- [ ] **Step 2: Write `listMatches.ts`**

`apps/web/src/lib/matching/listMatches.ts`:
```typescript
import { count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type DbClient } from "@ai-career/db";
import { toMatchView, type MatchView } from "./serializeMatch";

const { jobMatches, jobs } = schema;

export const PAGE_SIZE = 25;

export const ListMatchesQuerySchema = z.object({
  eligible: z.enum(["true", "false"]).default("true"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type ListMatchesQuery = z.infer<typeof ListMatchesQuerySchema>;

export interface MatchListItem {
  jobId: string;
  jobTitle: string;
  companyName: string;
  locationRaw: string | null;
  workMode: (typeof jobs.$inferSelect)["workMode"];
  match: MatchView;
}

export async function listMatches(
  tx: DbClient,
  query: ListMatchesQuery
): Promise<{ matches: MatchListItem[]; page: number; pageSize: number; total: number }> {
  const eligible = query.eligible === "true";
  const where = eq(jobMatches.eligible, eligible);

  const rows = await tx
    .select({
      id: jobMatches.id,
      jobId: jobMatches.jobId,
      eligible: jobMatches.eligible,
      ineligibleReason: jobMatches.ineligibleReason,
      skillsScore: jobMatches.skillsScore,
      experienceScore: jobMatches.experienceScore,
      locationScore: jobMatches.locationScore,
      sponsorshipScore: jobMatches.sponsorshipScore,
      roleScore: jobMatches.roleScore,
      salaryScore: jobMatches.salaryScore,
      industryScore: jobMatches.industryScore,
      freshnessScore: jobMatches.freshnessScore,
      semanticScore: jobMatches.semanticScore,
      overallScore: jobMatches.overallScore,
      explanation: jobMatches.explanation,
      explanationModel: jobMatches.explanationModel,
      explanationDescriptionHash: jobMatches.explanationDescriptionHash,
      explanationGeneratedAt: jobMatches.explanationGeneratedAt,
      userAction: jobMatches.userAction,
      userActionAt: jobMatches.userActionAt,
      computedAt: jobMatches.computedAt,
      createdAt: jobMatches.createdAt,
      userId: jobMatches.userId,
      careerGoalId: jobMatches.careerGoalId,
      jobTitle: jobs.title,
      companyName: jobs.companyName,
      locationRaw: jobs.locationRaw,
      workMode: jobs.workMode,
    })
    .from(jobMatches)
    .innerJoin(jobs, eq(jobs.id, jobMatches.jobId))
    .where(where)
    .orderBy(eligible ? sql`${jobMatches.overallScore} DESC NULLS LAST` : desc(jobMatches.computedAt), jobMatches.id)
    .limit(PAGE_SIZE)
    .offset((query.page - 1) * PAGE_SIZE);
  const [{ total }] = await tx.select({ total: count() }).from(jobMatches).where(where);

  return {
    matches: rows.map((row) => ({
      jobId: row.jobId,
      jobTitle: row.jobTitle,
      companyName: row.companyName,
      locationRaw: row.locationRaw,
      workMode: row.workMode,
      match: toMatchView(row),
    })),
    page: query.page,
    pageSize: PAGE_SIZE,
    total,
  };
}
```

- [ ] **Step 3: Write `matchActionSchema.ts`**

`apps/web/src/lib/matching/matchActionSchema.ts`:
```typescript
import { z } from "zod";

export const MatchActionSchema = z.object({
  userAction: z.enum(["none", "saved", "dismissed"]),
});
export type MatchAction = z.infer<typeof MatchActionSchema>;
```

- [ ] **Step 4: Write the failing test for `GET /api/matches`**

`apps/web/src/app/api/matches/route.test.ts`:
```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertCareerGoal, insertMatch } from "../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000c2",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

import { vi } from "vitest";

const USER = "00000000-0000-0000-0000-0000000000c2";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { GET } = await import("./route");
const list = (qs = "") => GET(new Request(`http://localhost/api/matches${qs}`));

describe("GET /api/matches", () => {
  it("lists eligible matches sorted by overall score, best first, by default", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const lowJob = await insertJob(admin, USER, { title: "Low" });
    const highJob = await insertJob(admin, USER, { title: "High" });
    await insertMatch(admin, USER, lowJob, goalId, { overallScore: 40 });
    await insertMatch(admin, USER, highJob, goalId, { overallScore: 90 });

    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches.map((m: { jobTitle: string }) => m.jobTitle)).toEqual(["High", "Low"]);
    expect(body.total).toBe(2);
  });

  it("lists ineligible matches with their reason when eligible=false", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, { title: "Excluded" });
    await insertMatch(admin, USER, jobId, goalId, { eligible: false, ineligibleReason: "You dismissed this job." });

    const res = await list("?eligible=false");
    const body = await res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].match.ineligibleReason).toBe("You dismissed this job.");
    expect(body.matches[0].match.overallScore).toBeNull();
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm --filter web test -- api/matches/route`
Expected: FAIL — `route.ts` does not exist.

- [ ] **Step 6: Implement `GET /api/matches`**

`apps/web/src/app/api/matches/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { formatValidationError } from "../../../lib/formatValidationError";
import { ListMatchesQuerySchema, listMatches } from "../../../lib/matching/listMatches";

export async function GET(request: Request) {
  const env = loadEnv();
  const parsed = ListMatchesQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }

  const db = createDbClient(env);
  try {
    const result = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => listMatches(tx, parsed.data));
    return NextResponse.json(result);
  } finally {
    await closeDbClient(db);
  }
}
```

- [ ] **Step 7: Run it to verify it passes**

Run: `pnpm --filter web test -- api/matches/route`
Expected: PASS.

- [ ] **Step 8: Write the failing test for `GET`/`PATCH /api/matches/[jobId]`**

`apps/web/src/app/api/matches/[jobId]/route.test.ts`:
```typescript
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { eq } from "drizzle-orm";
import { schema, withUserContext, createDbClient } from "@ai-career/db";
import { openAdminDb, wipeMatchingData, insertJob, insertCareerGoal, insertMatch } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000c3",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000c3";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { GET, PATCH } = await import("./route");
const get = (jobId: string) => GET(new Request(`http://localhost/api/matches/${jobId}`), { params: Promise.resolve({ jobId }) });
const patch = (jobId: string, body: unknown) =>
  PATCH(new Request(`http://localhost/api/matches/${jobId}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ jobId }) });

describe("GET /api/matches/[jobId]", () => {
  it("returns the job detail and match fields together", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, { title: "Data Engineer" });
    await insertMatch(admin, USER, jobId, goalId, { overallScore: 82 });

    const res = await get(jobId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.title).toBe("Data Engineer");
    expect(body.match.overallScore).toBe(82);
  });

  it("answers 404 when no match row exists for the job", async () => {
    const jobId = await insertJob(admin, USER);
    expect((await get(jobId)).status).toBe(404);
  });

  it("answers 404 for an unknown or malformed job id", async () => {
    expect((await get("00000000-0000-0000-0000-00000000ffff")).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
  });
});

describe("PATCH /api/matches/[jobId]", () => {
  it("sets userAction to 'dismissed' and stamps userActionAt", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER);
    await insertMatch(admin, USER, jobId, goalId);

    const res = await patch(jobId, { userAction: "dismissed" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.match.userAction).toBe("dismissed");

    const db = createDbClient({ DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test" });
    const [row] = await withUserContext(db, USER, (tx) => tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)));
    expect(row.userActionAt).not.toBeNull();
  });

  it("answers 400 on an invalid userAction value", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER);
    await insertMatch(admin, USER, jobId, goalId);
    expect((await patch(jobId, { userAction: "nope" })).status).toBe(400);
  });

  it("answers 404 when no match row exists for the job", async () => {
    const jobId = await insertJob(admin, USER);
    expect((await patch(jobId, { userAction: "saved" })).status).toBe(404);
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `pnpm --filter web test -- api/matches/jobId`
Expected: FAIL — `route.ts` does not exist.

- [ ] **Step 10: Implement `GET`/`PATCH /api/matches/[jobId]`**

`apps/web/src/app/api/matches/[jobId]/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { getJobDetail } from "../../../../lib/jobs/getJobDetail";
import { toMatchView } from "../../../../lib/matching/serializeMatch";
import { formatValidationError } from "../../../../lib/formatValidationError";
import { readJsonBody } from "../../../../lib/readJsonBody";
import { MatchActionSchema } from "../../../../lib/matching/matchActionSchema";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Match not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    return await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      const [matchRow] = await tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)).limit(1);
      if (!matchRow) return NextResponse.json({ error: "Match not found" }, { status: 404 });
      const job = await getJobDetail(tx, jobId);
      if (!job) return NextResponse.json({ error: "Match not found" }, { status: 404 });
      return NextResponse.json({ job, match: toMatchView(matchRow) });
    });
  } finally {
    await closeDbClient(db);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Match not found" }, { status: 404 });

  const env = loadEnv();
  const jsonBody = await readJsonBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = MatchActionSchema.safeParse(jsonBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }

  const db = createDbClient(env);
  try {
    return await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      const [existing] = await tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)).limit(1);
      if (!existing) return NextResponse.json({ error: "Match not found" }, { status: 404 });
      const [updated] = await tx
        .update(schema.jobMatches)
        .set({ userAction: parsed.data.userAction, userActionAt: new Date() })
        .where(eq(schema.jobMatches.jobId, jobId))
        .returning();
      return NextResponse.json({ match: toMatchView(updated) });
    });
  } finally {
    await closeDbClient(db);
  }
}
```

- [ ] **Step 11: Run it to verify it passes**

Run: `pnpm --filter web test -- api/matches/jobId`
Expected: PASS.

- [ ] **Step 12: Write the failing test for `GET /api/matches/runs/latest`**

`apps/web/src/app/api/matches/runs/latest/route.test.ts`:
```typescript
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertCareerGoal } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000c4",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));
import { vi } from "vitest";

const USER = "00000000-0000-0000-0000-0000000000c4";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { GET } = await import("./route");

describe("GET /api/matches/runs/latest", () => {
  it("returns null when no run has ever happened", async () => {
    const res = await GET();
    expect((await res.json()).run).toBeNull();
  });

  it("returns the most recent run's status and counts", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    await admin`INSERT INTO matching_runs (user_id, career_goal_id, started_at, finished_at, status, jobs_evaluated, jobs_eligible, jobs_explained)
                VALUES (${USER}, ${goalId}, now() - interval '1 hour', now() - interval '55 minutes', 'completed', 10, 6, 3)`;
    await admin`INSERT INTO matching_runs (user_id, career_goal_id, started_at, status)
                VALUES (${USER}, ${goalId}, now(), 'running')`;

    const res = await GET();
    const body = await res.json();
    expect(body.run.status).toBe("running");
  });
});
```

- [ ] **Step 13: Run it to verify it fails**

Run: `pnpm --filter web test -- runs/latest`
Expected: FAIL — `route.ts` does not exist.

- [ ] **Step 14: Implement `GET /api/matches/runs/latest`**

`apps/web/src/app/api/matches/runs/latest/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";

export async function GET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const [run] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx.select().from(schema.matchingRuns).orderBy(desc(schema.matchingRuns.startedAt)).limit(1)
    );
    if (!run) return NextResponse.json({ run: null });
    return NextResponse.json({
      run: {
        status: run.status,
        errorClass: run.errorClass,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        jobsEvaluated: run.jobsEvaluated,
        jobsEligible: run.jobsEligible,
        jobsExplained: run.jobsExplained,
      },
    });
  } finally {
    await closeDbClient(db);
  }
}
```

- [ ] **Step 15: Run it to verify it passes**

Run: `pnpm --filter web test -- runs/latest`
Expected: PASS.

- [ ] **Step 16: Typecheck, lint, full web test**

Run: `pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test`
Expected: all clean.

- [ ] **Step 17: Commit**

```bash
git add apps/web/src/lib/matching apps/web/src/app/api/matches
git commit -m "feat(web): matches list/detail/save-dismiss/run-status API routes"
```

### Task 12: Web — generate the career-goal embedding on confirm

**Files:**
- Modify: `apps/web/package.json` (add `@ai-career/matching` dependency)
- Modify: `apps/web/src/lib/career-goal/saveCareerGoal.ts`
- Modify: `apps/web/src/app/api/career-goal/confirm/route.test.ts`

**Interfaces:**
- Consumes: `ensureGoalEmbedding` from `@ai-career/matching` (Task 4).
- Produces: no new exports; `confirmCareerGoal` now also populates `career_goal_constraints.embedding` as its primary generation path (Task 8's `runMatching` fallback covers a row where this ever didn't run).

- [ ] **Step 1: Add the dependency**

In `apps/web/package.json`, add to `dependencies`:
```json
    "@ai-career/matching": "workspace:*",
```

Run: `pnpm install`

- [ ] **Step 2: Extend the confirm route test**

In `apps/web/src/app/api/career-goal/confirm/route.test.ts`, change the top mock and add the `@ai-career/ai` mock:

```typescript
vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000010",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ??
      "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    EMBEDDING_PROVIDER: "voyage",
    VOYAGE_API_KEY: "test-key",
    VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
  }),
}));
vi.mock("@ai-career/ai", () => ({ embedTexts: vi.fn() }));
```

Add `import { vi } from "vitest";` alongside the existing `describe, it, expect, ...` import, and add `import { embedTexts } from "@ai-career/ai";` after the mock block. `career_goal_constraints.embedding` is a strict `vector(1024)` column (Task 3) — Postgres rejects any other length outright, so the mock must return a real 1024-length array, not a short illustrative one (Task 4 hit and fixed this same trap in its own tests; this note prevents it recurring here). Add near the top of the file: `const FAKE_EMBEDDING = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 0.1 : 0));`. In `beforeAll`, after the existing DELETEs, add `vi.mocked(embedTexts).mockReset().mockResolvedValue([FAKE_EMBEDDING]);` — every existing test in this file already exercises a successful confirm, so giving Voyage a working default keeps them green without individually touching each one.

Add two new tests at the end of the `describe` block:
```typescript
  it("generates and stores the career-goal embedding on confirm", async () => {
    const goalId = await insertPendingGoal("Data jobs, remote, Python and SQL", 20);
    await POST(makeRequest({ goalId, constraints: { ...validConstraints, skills: ["Python", "SQL"] } }));

    const [row] = await adminSql`SELECT embedding IS NOT NULL AS has_embedding, embedding_model FROM career_goal_constraints WHERE career_goal_id = ${goalId}`;
    expect(row.has_embedding).toBe(true);
    expect(row.embedding_model).toBe("voyage-3.5");
    expect(vi.mocked(embedTexts)).toHaveBeenCalled();
  });

  it("still confirms successfully when embedding generation fails", async () => {
    vi.mocked(embedTexts).mockRejectedValueOnce(new Error("voyage down"));
    const goalId = await insertPendingGoal("Data jobs", 21);

    const res = await POST(makeRequest({ goalId, constraints: validConstraints }));
    expect(res.status).toBe(200);

    const [row] = await adminSql`SELECT embedding FROM career_goal_constraints WHERE career_goal_id = ${goalId}`;
    expect(row.embedding).toBeNull();
  });
```

- [ ] **Step 3: Run it to verify the new tests fail**

Run: `pnpm --filter web test -- career-goal/confirm`
Expected: FAIL — `saveCareerGoal.ts` does not yet generate an embedding.

- [ ] **Step 4: Edit `saveCareerGoal.ts`**

Add the import:
```typescript
import { ensureGoalEmbedding } from "@ai-career/matching";
```

Change the body of `confirmCareerGoal` so the `withUserContext` block returns the new constraints row's id, and generate the embedding in a separate transaction afterward:

```typescript
export async function confirmCareerGoal(
  env: Env,
  goalId: string,
  constraints: CareerGoalConstraintsInput
): Promise<void> {
  const db = createDbClient(env);
  try {
    const constraintsId = await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      await lockUserCareerGoals(tx, env.DEFAULT_USER_ID);
      const [goal] = await tx
        .select({
          parseStatus: schema.careerGoals.parseStatus,
          confirmationStatus: schema.careerGoals.confirmationStatus,
        })
        .from(schema.careerGoals)
        .where(eq(schema.careerGoals.id, goalId))
        .for("update");
      if (!goal) {
        throw new CareerGoalNotFoundError(`No career_goals row with id ${goalId}`);
      }
      if (goal.confirmationStatus === "confirmed") {
        throw new CareerGoalStateError("already-confirmed");
      }
      if (goal.parseStatus !== "parsed") {
        throw new CareerGoalStateError("not-parsed");
      }

      await tx
        .update(schema.careerGoals)
        .set({ isActive: false })
        .where(eq(schema.careerGoals.isActive, true));

      const [constraintsRow] = await tx
        .insert(schema.careerGoalConstraints)
        .values({
          careerGoalId: goalId,
          targetRoles: constraints.targetRoles,
          seniority: constraints.seniority,
          locations: constraints.locations,
          workMode: constraints.workMode,
          minExperienceYears: constraints.minExperienceYears,
          employmentType: constraints.employmentType,
          salaryFloorRaw: constraints.salaryFloorRaw,
          salaryFloorNormalized:
            constraints.salaryFloorNormalized === null ? null : String(constraints.salaryFloorNormalized),
          salaryCurrency: constraints.salaryCurrency,
          salaryIsParsed: constraints.salaryIsParsed,
          salaryTargetRaw: constraints.salaryTargetRaw,
          salaryTargetNormalized:
            constraints.salaryTargetNormalized === null ? null : String(constraints.salaryTargetNormalized),
          salaryTargetCurrency: constraints.salaryTargetCurrency,
          salaryTargetIsParsed: constraints.salaryTargetIsParsed,
          visaSponsorshipRequired: constraints.visaSponsorshipRequired,
          skills: constraints.skills,
          preferredIndustries: constraints.preferredIndustries,
          excludedIndustries: constraints.excludedIndustries,
          preferredCompanies: constraints.preferredCompanies,
          excludedCompanies: constraints.excludedCompanies,
          hardConstraints: constraints.hardConstraints,
        })
        .returning({ id: schema.careerGoalConstraints.id });

      await tx
        .update(schema.careerGoals)
        .set({ confirmationStatus: "confirmed", isActive: true, confirmedAt: new Date() })
        .where(eq(schema.careerGoals.id, goalId));

      return constraintsRow.id;
    });

    // Outside the confirm transaction, same rationale as saveProfile.ts (Phase 2): a Voyage outage
    // must not roll back the already-committed confirm, and the confirm transaction must not hold a
    // Postgres transaction open for the duration of an external HTTP call. `ensureGoalEmbedding`
    // itself degrades to a no-op (leaves `embedding` null) on any failure; Phase 5's `runMatching`
    // falls back to generating it lazily on the first "Find Matches" run if this ever didn't run
    // (design doc §10's last item).
    await withUserContext(db, env.DEFAULT_USER_ID, (tx) => ensureGoalEmbedding(tx, env, constraintsId));
  } finally {
    await closeDbClient(db);
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter web test -- career-goal/confirm`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm --filter web typecheck && pnpm --filter web lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json apps/web/src/lib/career-goal/saveCareerGoal.ts \
        apps/web/src/app/api/career-goal/confirm/route.test.ts pnpm-lock.yaml
git commit -m "feat(web): generate the career-goal embedding on confirm"
```

### Task 13: Web — `/matches` page, `MatchesClient`, `MatchRow`

**Files:**
- Create: `apps/web/src/app/matches/page.tsx`, `apps/web/src/app/matches/MatchesClient.tsx`, `apps/web/src/app/matches/MatchRow.tsx`
- Test: `apps/web/src/app/matches/MatchesClient.test.tsx`

**Interfaces:**
- Consumes: `MatchListItem` (Task 11, imported as a type only — no server code runs client-side); `GET /api/matches`, `POST /api/matches/run`, `GET /api/matches/runs/latest`, `PATCH /api/matches/[jobId]`.

- [ ] **Step 1: Write `MatchRow.tsx`**

`apps/web/src/app/matches/MatchRow.tsx`:
```typescript
import Link from "next/link";
import type { MatchListItem } from "../../lib/matching/listMatches";

const FACTOR_LABELS: [key: keyof NonNullable<MatchListItem["match"]["factors"]>, label: string][] = [
  ["skills", "Skills"], ["experience", "Experience"], ["location", "Location"], ["sponsorship", "Sponsorship"],
  ["role", "Role"], ["salary", "Salary"], ["industry", "Industry"], ["freshness", "Freshness"], ["semantic", "Fit"],
];

export function MatchRow({
  item, busy, onSave, onDismiss,
}: {
  item: MatchListItem;
  busy: boolean;
  onSave: () => void;
  onDismiss: () => void;
}) {
  const { match } = item;
  return (
    <li className="flex flex-col gap-2 rounded border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href={`/matches/${item.jobId}`} className="font-medium underline">{item.jobTitle}</Link>
          <p className="text-sm text-gray-600">{item.companyName} · {item.locationRaw ?? "Location unknown"} · {item.workMode}</p>
        </div>
        {match.overallScore !== null && (
          <span className="shrink-0 rounded bg-black px-2 py-1 text-sm font-semibold text-white">{match.overallScore}/100</span>
        )}
      </div>

      {!match.eligible && match.ineligibleReason && (
        <p className="text-sm text-gray-600">{match.ineligibleReason}</p>
      )}

      {match.eligible && match.factors && (
        <ul className="flex flex-wrap gap-2 text-xs" aria-label="Match factors">
          {FACTOR_LABELS.map(([key, label]) => {
            const value = match.factors![key];
            return (
              <li key={key} className="rounded-full border px-2 py-0.5">
                {label}: {value === null ? "n/a" : `${value}%`}
              </li>
            );
          })}
        </ul>
      )}

      {match.explanation?.summary && <p className="text-sm">{match.explanation.summary}</p>}

      {match.eligible && (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={onSave} className="rounded border px-3 py-1 text-sm disabled:opacity-50">
            {match.userAction === "saved" ? "Saved" : "Save"}
          </button>
          <button type="button" disabled={busy} onClick={onDismiss} className="rounded border px-3 py-1 text-sm disabled:opacity-50">Dismiss</button>
        </div>
      )}
    </li>
  );
}
```

- [ ] **Step 2: Write the failing test for `MatchesClient`**

`apps/web/src/app/matches/MatchesClient.test.tsx`:
```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MatchesClient } from "./MatchesClient";

const matchItem = (over: Record<string, unknown> = {}) => ({
  jobId: "j1", jobTitle: "Data Engineer", companyName: "Acme", locationRaw: "Berlin", workMode: "remote",
  match: {
    matchId: "m1", eligible: true, ineligibleReason: null, overallScore: 82,
    factors: { skills: 80, experience: 100, location: 100, sponsorship: 100, role: 90, salary: null, industry: 100, freshness: 100, semantic: 70 },
    explanation: { strongMatches: ["Strong SQL"], partialMatches: [], gaps: [], summary: "A strong overall match." },
    userAction: "none", computedAt: "2026-09-22T00:00:00Z",
    ...over,
  },
});

type Handler = (init?: RequestInit) => { status?: number; body: unknown };
function mockFetch(handlers: Record<string, Handler>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const handler = handlers[`${init?.method ?? "GET"} ${url}`];
    if (!handler) throw new Error(`unhandled request: ${init?.method ?? "GET"} ${url}`);
    const { status = 200, body } = handler(init);
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => vi.unstubAllGlobals());

describe("MatchesClient", () => {
  it("shows a helpful empty state", async () => {
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    expect(await screen.findByText(/No matches yet/)).toBeInTheDocument();
  });

  it("lists eligible matches with score and factor chips", async () => {
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [matchItem()], page: 1, pageSize: 25, total: 1 } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    expect(await screen.findByText("Data Engineer")).toBeInTheDocument();
    expect(screen.getByText("82/100")).toBeInTheDocument();
    expect(screen.getByText("Skills: 80%")).toBeInTheDocument();
    expect(screen.getByText("A strong overall match.")).toBeInTheDocument();
  });

  it("queues a matching run and shows a notice", async () => {
    const fn = mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
      "POST /api/matches/run": () => ({ status: 202, body: { status: "queued" } }),
    });
    render(<MatchesClient />);
    const button = await screen.findByRole("button", { name: "Find Matches" });
    fireEvent.click(button);
    expect(await screen.findByRole("status")).toHaveTextContent(/Queued a matching run/);
    expect(fn).toHaveBeenCalledWith("/api/matches/run", expect.objectContaining({ method: "POST" }));
  });

  it("dismisses a match and removes it from the eligible list", async () => {
    let matches = [matchItem()];
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches, page: 1, pageSize: 25, total: matches.length } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
      "PATCH /api/matches/j1": () => {
        matches = [];
        return { body: { match: { ...matchItem().match, eligible: false, userAction: "dismissed" } } };
      },
    });
    render(<MatchesClient />);
    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    fireEvent.click(dismiss);
    await waitFor(() => expect(screen.queryByText("Data Engineer")).not.toBeInTheDocument());
  });

  it("toggles to show ineligible matches with their reason", async () => {
    const ineligible = matchItem({ eligible: false, ineligibleReason: "You dismissed this job.", overallScore: null, factors: null, explanation: null });
    mockFetch({
      "GET /api/matches?eligible=true&page=1": () => ({ body: { matches: [], page: 1, pageSize: 25, total: 0 } }),
      "GET /api/matches?eligible=false&page=1": () => ({ body: { matches: [ineligible], page: 1, pageSize: 25, total: 1 } }),
      "GET /api/matches/runs/latest": () => ({ body: { run: null } }),
    });
    render(<MatchesClient />);
    await screen.findByText(/No matches yet/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Show excluded jobs/ }));
    expect(await screen.findByText("You dismissed this job.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter web test -- MatchesClient`
Expected: FAIL — `MatchesClient.tsx` does not exist.

- [ ] **Step 4: Implement `MatchesClient.tsx`**

`apps/web/src/app/matches/MatchesClient.tsx`:
```typescript
"use client";

import { useCallback, useEffect, useState } from "react";
import type { MatchListItem } from "../../lib/matching/listMatches";
import { MatchRow } from "./MatchRow";

const POLL_INTERVAL_MS = 3000;
const POLL_DURATION_MS = 60_000;

interface Result {
  matches: MatchListItem[];
  page: number;
  pageSize: number;
  total: number;
}

export function MatchesClient() {
  const [showIneligible, setShowIneligible] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollUntil, setPollUntil] = useState(0);

  const load = useCallback(
    () =>
      fetch(`/api/matches?eligible=${!showIneligible}&page=1`)
        .then((res) => {
          if (!res.ok) throw new Error("load failed");
          return res.json();
        })
        .then((body: Result) => {
          setResult(body);
          setLoadFailed(false);
        })
        .catch(() => setLoadFailed(true)),
    [showIneligible]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (pollUntil <= Date.now()) return;
    const timer = setInterval(() => {
      if (Date.now() > pollUntil) clearInterval(timer);
      else void load();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pollUntil, load]);

  async function findMatches() {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/matches/run", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Something went wrong.");
        return;
      }
      setNotice("Queued a matching run. Make sure the worker is running (pnpm --filter @ai-career/matching-worker start).");
      setPollUntil(Date.now() + POLL_DURATION_MS);
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    }
  }

  async function act(jobId: string, userAction: "saved" | "dismissed") {
    setBusyJobId(jobId);
    setError(null);
    try {
      const res = await fetch(`/api/matches/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAction }),
      });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? "Something went wrong.");
        return;
      }
      await load();
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setBusyJobId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" onClick={() => void findMatches()} className="rounded bg-black px-4 py-1.5 text-sm text-white">
          Find Matches
        </button>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showIneligible} onChange={(e) => setShowIneligible(e.target.checked)} />
          Show excluded jobs
        </label>
      </div>

      {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {loadFailed && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-600">Could not load matches — check your connection and try again.</p>
          <button type="button" onClick={() => void load()} className="w-fit rounded border px-4 py-2 text-sm">Retry</button>
        </div>
      )}

      {result === null && !loadFailed && <p>Loading...</p>}
      {result !== null && result.total === 0 && (
        <p className="text-sm text-gray-600">
          {showIneligible ? "No excluded jobs." : "No matches yet — confirm a career goal, run job ingestion, then Find Matches."}
        </p>
      )}
      {result !== null && result.total > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Matches">
          {result.matches.map((item) => (
            <MatchRow
              key={item.jobId}
              item={item}
              busy={busyJobId === item.jobId}
              onSave={() => void act(item.jobId, "saved")}
              onDismiss={() => void act(item.jobId, "dismissed")}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter web test -- MatchesClient`
Expected: PASS.

- [ ] **Step 6: Write the page**

`apps/web/src/app/matches/page.tsx`:
```typescript
import { MatchesClient } from "./MatchesClient";

export default function MatchesPage() {
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="mb-2 text-2xl font-semibold">Matches</h1>
      <p className="mb-6 text-sm text-gray-600">
        Jobs ranked against your confirmed career goal, with why each one scored the way it did.
      </p>
      <MatchesClient />
    </main>
  );
}
```

- [ ] **Step 7: Typecheck, lint, full web test**

Run: `pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/matches
git commit -m "feat(web): /matches page with ranked list, factor chips, save/dismiss"
```

### Task 14: Web — `/matches/[jobId]` detail page, home link, `.env.example`

**Files:**
- Create: `apps/web/src/app/matches/[jobId]/page.tsx`, `apps/web/src/app/matches/[jobId]/MatchDetailClient.tsx`
- Test: `apps/web/src/app/matches/[jobId]/MatchDetailClient.test.tsx`
- Modify: `apps/web/src/app/page.tsx`, `.env.example`

**Interfaces:**
- Consumes: `GET /api/matches/[jobId]` (Task 11); `JobDetail` fields for display; `MatchView` fields for display.

- [ ] **Step 1: Write the failing test for `MatchDetailClient`**

`apps/web/src/app/matches/[jobId]/MatchDetailClient.test.tsx`:
```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MatchDetailClient } from "./MatchDetailClient";

const job = { id: "j1", title: "Data Engineer", companyName: "Acme", locationRaw: "Berlin", workMode: "remote", descriptionText: "We use SQL." };
const match = {
  matchId: "m1", eligible: true, ineligibleReason: null, overallScore: 82,
  factors: { skills: 80, experience: 100, location: 100, sponsorship: 100, role: 90, salary: null, industry: 100, freshness: 100, semantic: 70 },
  explanation: { strongMatches: ["Strong SQL alignment"], partialMatches: ["Slightly under target salary"], gaps: ["Tableau requested, not found"], summary: "A strong overall match." },
  userAction: "none", computedAt: "2026-09-22T00:00:00Z",
};

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as Response));
}
beforeEach(() => vi.unstubAllGlobals());

describe("MatchDetailClient", () => {
  it("shows the job, score, and the strong/partial/gap breakdown", async () => {
    mockFetch({ job, match });
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByText("Data Engineer")).toBeInTheDocument();
    expect(screen.getByText("82/100")).toBeInTheDocument();
    expect(screen.getByText("Strong SQL alignment")).toBeInTheDocument();
    expect(screen.getByText("Slightly under target salary")).toBeInTheDocument();
    expect(screen.getByText("Tableau requested, not found")).toBeInTheDocument();
  });

  it("shows the ineligible reason instead of scores when excluded", async () => {
    mockFetch({ job, match: { ...match, eligible: false, ineligibleReason: "You dismissed this job.", overallScore: null, factors: null, explanation: null } });
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByText("You dismissed this job.")).toBeInTheDocument();
  });

  it("shows a not-found state for a 404", async () => {
    mockFetch({ error: "Match not found" }, 404);
    render(<MatchDetailClient jobId="j1" />);
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test -- MatchDetailClient`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `MatchDetailClient.tsx`**

`apps/web/src/app/matches/[jobId]/MatchDetailClient.tsx`:
```typescript
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface JobView {
  id: string;
  title: string;
  companyName: string;
  locationRaw: string | null;
  workMode: string;
  descriptionText: string;
}
interface MatchView {
  eligible: boolean;
  ineligibleReason: string | null;
  overallScore: number | null;
  factors: Record<string, number | null> | null;
  explanation: { strongMatches: string[]; partialMatches: string[]; gaps: string[]; summary: string } | null;
  userAction: "none" | "saved" | "dismissed";
}

type Outcome = { kind: "missing" } | { kind: "error" } | { kind: "ready"; job: JobView; match: MatchView };
type State = { kind: "loading" } | Outcome;

const FACTOR_LABELS: [string, string][] = [
  ["skills", "Skills"], ["experience", "Experience"], ["location", "Location"], ["sponsorship", "Sponsorship"],
  ["role", "Role"], ["salary", "Salary"], ["industry", "Industry"], ["freshness", "Freshness"], ["semantic", "Fit"],
];

export function MatchDetailClient({ jobId }: { jobId: string }) {
  const [loaded, setLoaded] = useState<{ jobId: string; outcome: Outcome } | null>(null);
  const state: State = loaded !== null && loaded.jobId === jobId ? loaded.outcome : { kind: "loading" };

  useEffect(() => {
    let cancelled = false;
    const finish = (outcome: Outcome) => {
      if (!cancelled) setLoaded({ jobId, outcome });
    };
    fetch(`/api/matches/${encodeURIComponent(jobId)}`)
      .then(async (res) => {
        if (res.status === 404) return finish({ kind: "missing" });
        if (!res.ok) return finish({ kind: "error" });
        const body = await res.json();
        if (body && typeof body.job === "object" && typeof body.match === "object") {
          finish({ kind: "ready", job: body.job, match: body.match });
        } else {
          finish({ kind: "error" });
        }
      })
      .catch(() => finish({ kind: "error" }));
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const back = <Link href="/matches" className="text-sm underline">← All matches</Link>;

  if (state.kind === "loading") return <p>Loading...</p>;
  if (state.kind === "missing") return <div className="flex flex-col gap-3"><p>Match not found.</p>{back}</div>;
  if (state.kind === "error") return <div className="flex flex-col gap-3"><p role="alert" className="text-red-600">Could not load this match.</p>{back}</div>;

  const { job, match } = state;

  return (
    <div className="flex flex-col gap-6">
      {back}
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{job.title}</h1>
          <p className="text-sm text-gray-600">{job.companyName} · {job.locationRaw ?? "Location unknown"} · {job.workMode}</p>
        </div>
        {match.overallScore !== null && (
          <span className="shrink-0 rounded bg-black px-3 py-1.5 text-lg font-semibold text-white">{match.overallScore}/100</span>
        )}
      </header>

      {!match.eligible && match.ineligibleReason && (
        <p className="rounded border p-4 text-sm">{match.ineligibleReason}</p>
      )}

      {match.eligible && match.factors && (
        <section aria-labelledby="factors-heading">
          <h2 id="factors-heading" className="mb-2 font-medium">Match factors</h2>
          <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
            {FACTOR_LABELS.map(([key, label]) => (
              <div key={key} className="contents">
                <dt className="text-gray-600">{label}</dt>
                <dd>{match.factors![key] === null ? "Not comparable" : `${match.factors![key]}%`}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {match.explanation && (
        <section aria-labelledby="explanation-heading">
          <h2 id="explanation-heading" className="mb-2 font-medium">Why this match</h2>
          <p className="mb-3 text-sm">{match.explanation.summary}</p>
          {match.explanation.strongMatches.length > 0 && (
            <div className="mb-2">
              <h3 className="text-sm font-medium text-green-700">Strong matches</h3>
              <ul className="list-disc pl-5 text-sm">{match.explanation.strongMatches.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
          {match.explanation.partialMatches.length > 0 && (
            <div className="mb-2">
              <h3 className="text-sm font-medium text-yellow-700">Partial matches</h3>
              <ul className="list-disc pl-5 text-sm">{match.explanation.partialMatches.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
          {match.explanation.gaps.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-red-700">Gaps</h3>
              <ul className="list-disc pl-5 text-sm">{match.explanation.gaps.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="description-heading">
        <h2 id="description-heading" className="mb-2 font-medium">Job description</h2>
        <p className="whitespace-pre-wrap text-sm text-gray-700">{job.descriptionText}</p>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter web test -- MatchDetailClient`
Expected: PASS.

- [ ] **Step 5: Write the page**

`apps/web/src/app/matches/[jobId]/page.tsx`:
```typescript
import { MatchDetailClient } from "./MatchDetailClient";

// Next 16: dynamic route params arrive as a Promise.
export default async function MatchPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return (
    <main className="mx-auto max-w-3xl p-8">
      <MatchDetailClient jobId={jobId} />
    </main>
  );
}
```

- [ ] **Step 6: Link `/matches` from the home page**

In `apps/web/src/app/page.tsx`, add a fifth nav entry after the `/jobs` link:
```typescript
        <Link href="/matches" className="underline">
          5. Matches — see jobs ranked against your career goal
        </Link>
```

- [ ] **Step 7: Document the new env vars**

Append to `.env.example`, after the `INGEST_INTERVAL_MINUTES` block:
```bash
# Phase 5 matching. Defaults are starting guesses (design doc §10), all overridable.
# How many top-ranked eligible jobs get an AI-generated explanation per run.
# MATCHING_EXPLAIN_TOP_N=25
# Years beyond a job's stated minimum experience that still counts as eligible.
# MATCHING_EXPERIENCE_GRACE_YEARS=1
# Freshness-score half-life in hours (job postings older than this decay toward zero).
# MATCHING_FRESHNESS_HALF_LIFE_HOURS=168
# Days before a stored AI explanation is regenerated even if nothing else changed.
# MATCHING_EXPLANATION_TTL_DAYS=7
```

- [ ] **Step 8: Typecheck, lint, full web test**

Run: `pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test`
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/app/matches apps/web/src/app/page.tsx .env.example
git commit -m "feat(web): /matches/[jobId] detail page, home nav link, matching env docs"
```

### Task 15: AI evaluation set for match explanations

**Files:**
- Create: `packages/matching/eval/match-explanation-fixtures/*.json` (3 fixtures)
- Create: `packages/matching/eval/scoreExplanationEval.ts`

**Interfaces:**
- Consumes: `generateMatchExplanation`, `MatchExplanationInput` (Task 6); `createAnthropicClient` from `@ai-career/ai`; `loadEnv` from `@ai-career/config`.
- Produces: a manual, real-API script (`pnpm eval:explanation`), per CLAUDE.md §10 ("AI evaluation... resume extraction, job extraction, career-goal parsing, job matching, skill-gap analysis, recommendation quality"). Not run in CI (same reason as `packages/ai/eval/scoreCareerGoalAccuracy.ts`: it bills a real Anthropic account).

- [ ] **Step 1: Write the fixtures**

`packages/matching/eval/match-explanation-fixtures/skill-gap.json`:
```json
{
  "input": {
    "jobTitle": "Senior Data Analyst",
    "companyName": "Acme Analytics",
    "overallScore": 78,
    "skillMatches": [
      { "skill": "SQL", "found": true },
      { "skill": "Python", "found": true },
      { "skill": "Tableau", "found": false }
    ],
    "experience": { "requiredYears": 3, "candidateYears": 5 },
    "workMode": { "job": "remote", "goal": "remote" },
    "sponsorship": { "required": false, "job": "unknown" },
    "salary": { "comparable": true, "withinRange": true },
    "freshnessDays": 1
  },
  "expectedStrongMentions": ["SQL", "Python"],
  "expectedGapMentions": ["Tableau"]
}
```

`packages/matching/eval/match-explanation-fixtures/sponsorship-unknown.json`:
```json
{
  "input": {
    "jobTitle": "Data Engineer",
    "companyName": "Globex",
    "overallScore": 61,
    "skillMatches": [{ "skill": "SQL", "found": true }],
    "experience": { "requiredYears": 5, "candidateYears": 5 },
    "workMode": { "job": "hybrid", "goal": "any" },
    "sponsorship": { "required": true, "job": "unknown" },
    "salary": { "comparable": false, "withinRange": null },
    "freshnessDays": 10
  },
  "expectedStrongMentions": ["SQL"],
  "expectedGapMentions": ["sponsorship"]
}
```

`packages/matching/eval/match-explanation-fixtures/below-salary-floor.json`:
```json
{
  "input": {
    "jobTitle": "Data Analyst",
    "companyName": "Initech",
    "overallScore": 45,
    "skillMatches": [{ "skill": "Excel", "found": true }],
    "experience": { "requiredYears": 2, "candidateYears": 5 },
    "workMode": { "job": "onsite", "goal": "onsite" },
    "sponsorship": { "required": false, "job": "offered" },
    "salary": { "comparable": true, "withinRange": false },
    "freshnessDays": 30
  },
  "expectedStrongMentions": ["Excel"],
  "expectedGapMentions": ["salary"]
}
```

- [ ] **Step 2: Write the eval script**

`packages/matching/eval/scoreExplanationEval.ts`:
```typescript
/**
 * Manual match-explanation accuracy scorer -- same rationale as
 * packages/ai/eval/scoreCareerGoalAccuracy.ts: this proves the explanation *pipeline* round-trips
 * correctly (unit + integration tests already do that against a fake client), never that a real
 * model's prose actually mentions the right facts. Run manually whenever ANTHROPIC_MODEL_FAST or
 * generateMatchExplanation.ts's prompt/schema changes.
 *
 * Usage (from packages/matching, with a real ANTHROPIC_API_KEY in the repo root .env):
 * `pnpm eval:explanation`
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@ai-career/config";
import { createAnthropicClient } from "@ai-career/ai";
import { generateMatchExplanation, type MatchExplanationInput } from "../src/explanation/generateMatchExplanation";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "match-explanation-fixtures");

interface Fixture {
  input: MatchExplanationInput;
  expectedStrongMentions: string[];
  expectedGapMentions: string[];
}

function normalize(value: string): string {
  return value.toLowerCase();
}

function recall(expected: string[], actual: string[]): number {
  if (expected.length === 0) return 1;
  const haystack = actual.map(normalize).join(" | ");
  const matched = expected.filter((term) => haystack.includes(normalize(term)));
  return matched.length / expected.length;
}

async function main() {
  const env = loadEnv();
  const client = createAnthropicClient(env);

  const fixtureNames = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  const scores: number[] = [];

  for (const fixtureName of fixtureNames) {
    const fixture: Fixture = JSON.parse(readFileSync(path.join(FIXTURES_DIR, fixtureName), "utf-8"));

    let strongScore = 0;
    let gapScore = 0;
    try {
      const draft = await generateMatchExplanation(client, env, fixture.input);
      strongScore = recall(fixture.expectedStrongMentions, draft.strongMatches);
      gapScore = recall(fixture.expectedGapMentions, draft.gaps);
    } catch (error) {
      console.log(`\n${fixtureName}: EXPLANATION FAILED -- ${(error as Error).message}`);
    }

    const overall = (strongScore + gapScore) / 2;
    scores.push(overall);
    console.log(`\n${fixtureName}: ${(overall * 100).toFixed(0)}% (strongMatches recall ${(strongScore * 100).toFixed(0)}%, gaps recall ${(gapScore * 100).toFixed(0)}%)`);
  }

  const average = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  console.log(`\n--- Average across ${scores.length} fixtures: ${(average * 100).toFixed(0)}% ---`);
  console.log(
    "This is a rough recall-style signal (does the explanation mention the expected facts), not a\n" +
      "strict correctness proof -- read the per-fixture output above before trusting a single number."
  );
}

main();
```

- [ ] **Step 3: Verify the script runs (requires a real `ANTHROPIC_API_KEY` in the repo root `.env`)**

Run: `pnpm --filter @ai-career/matching eval:explanation`
Expected: prints a per-fixture and average score. Record the result in this task's commit message or DECISIONS.md (Task 17) — this is a "never measured against a real model" gap otherwise, same class of gap D-line52 already flags for career-goal extraction.

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm --filter @ai-career/matching typecheck && pnpm --filter @ai-career/matching lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/matching/eval
git commit -m "feat(matching): real-model evaluation set for match explanations"
```

### Task 16: End-to-end smoke test (fake Anthropic server + real queue/worker/web)

**Files:**
- Create: `services/matching-worker/e2e/fakeAnthropic.ts`, `services/matching-worker/e2e/smoke.ts`
- Modify: `services/matching-worker/package.json` (add `e2e:fake-anthropic` / `e2e:smoke` scripts)

**Interfaces:**
- No importable interfaces — this is a standalone script run manually against real processes, same category as `services/job-ingestion/e2e/smoke.ts` (Phase 4's own E2E is documented there as "an HTTP-level smoke test, not an automated Chrome test" — this follows the same, cheaper pattern rather than driving a real browser).

- [ ] **Step 1: Write the fake Anthropic server**

`services/matching-worker/e2e/fakeAnthropic.ts`:
```typescript
// A minimal stand-in for POST https://api.anthropic.com/v1/messages, answering every request with a
// fixed record_match_explanation tool_use block so the matching worker's explanation step can run
// without a paid ANTHROPIC_API_KEY. Point the worker at it with ANTHROPIC_BASE_URL (the Anthropic SDK
// reads this env var) -- same recipe used for Phase 2/3's manual E2E checks (see MEMORY.md).
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4012);

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const toolName = parsed.tools?.[0]?.name ?? "unknown_tool";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_fake",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_fake",
            name: toolName,
            input: {
              strongMatches: ["Fake strong match"],
              partialMatches: [],
              gaps: ["Fake gap"],
              summary: "Fake explanation from the E2E stand-in server.",
            },
          },
        ],
        model: parsed.model,
        stop_reason: "tool_use",
      })
    );
  });
});

server.listen(PORT, () => console.log(`fake Anthropic server listening on :${PORT}`));
```

- [ ] **Step 2: Add the npm scripts**

In `services/matching-worker/package.json`, add to `scripts`:
```json
    "e2e:fake-anthropic": "tsx e2e/fakeAnthropic.ts",
    "e2e:smoke": "tsx e2e/smoke.ts"
```

- [ ] **Step 3: Write the smoke script**

`services/matching-worker/e2e/smoke.ts`:
```typescript
// End-to-end smoke test over real HTTP, the real queue, and the real matching + ingestion workers.
// Prerequisites (four terminals):
//   1. fake Anthropic: pnpm --filter @ai-career/matching-worker e2e:fake-anthropic
//   2. ingestion worker (to process the upload below): pnpm --filter @ai-career/job-ingestion start
//   3. matching worker: ANTHROPIC_BASE_URL=http://localhost:4012 pnpm --filter @ai-career/matching-worker start
//   4. web: pnpm --filter web start   (after `pnpm --filter web build`)
// Then: pnpm --filter @ai-career/matching-worker e2e:smoke
//
// Expects a database where a candidate profile already exists (Phase 2's flow) but no confirmed
// career goal and no jobs -- point it at a scratch database, same convention as
// services/job-ingestion/e2e/smoke.ts, and seed the profile first via the web UI or API.
const WEB = process.env.WEB_URL ?? "http://localhost:3000";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : detail ? `  -> ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${WEB}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (path: string, body?: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const patch = (path: string, body: unknown) =>
  call(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function waitFor<T>(label: string, fn: () => Promise<T | null>, timeoutSeconds = 60): Promise<T> {
  for (let i = 0; i < timeoutSeconds; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function main() {
  // 1. Career goal: parse + confirm with a remote Data Engineer preference and SQL/Python skills.
  const parsed = await post("/api/career-goal/parse", { rawText: "Remote Data Engineer roles, at least 2 years experience, skills SQL and Python." });
  check("career goal parsed", parsed.status === 200, JSON.stringify(parsed.body));
  const goalId = parsed.body.goalId;
  const confirmed = await post("/api/career-goal/confirm", {
    goalId,
    constraints: {
      targetRoles: ["Data Engineer"], seniority: null, locations: [], workMode: "remote", minExperienceYears: 2,
      employmentType: null, salaryFloorRaw: null, salaryFloorNormalized: null, salaryCurrency: null, salaryIsParsed: false,
      salaryTargetRaw: null, salaryTargetNormalized: null, salaryTargetCurrency: null, salaryTargetIsParsed: false,
      visaSponsorshipRequired: null, skills: ["SQL", "Python"], preferredIndustries: [], excludedIndustries: [],
      preferredCompanies: [], excludedCompanies: ["Excluded Co"], hardConstraints: [],
    },
  });
  check("career goal confirmed", confirmed.status === 200, JSON.stringify(confirmed.body));

  // 2. Seed two jobs via the existing JSON upload path (Phase 4): one clearly eligible and strong, one excluded by company.
  const uploadBody = {
    consentConfirmed: true,
    records: [
      { externalId: "e2e-1", title: "Senior Data Engineer", companyName: "Acme", locationRaw: "Remote", descriptionText: "We use SQL and Python daily. 3+ years experience.", url: "https://example.com/1" },
      { externalId: "e2e-2", title: "Data Engineer", companyName: "Excluded Co", locationRaw: "Remote", descriptionText: "SQL required.", url: "https://example.com/2" },
    ],
  };
  const upload = await fetch(`${WEB}/api/job-sources/upload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(uploadBody) });
  check("jobs uploaded", upload.status === 201, await upload.text());

  await waitFor("uploaded jobs to appear", async () => {
    const jobs = await call("/api/jobs?status=all");
    return jobs.body.total >= 2 ? jobs.body : null;
  });

  // 3. Trigger matching and wait for a completed run.
  const run = await post("/api/matches/run");
  check("matching run queued", run.status === 202, JSON.stringify(run.body));
  const finished = await waitFor("matching run to finish", async () => {
    const latest = await call("/api/matches/runs/latest");
    return latest.body.run && latest.body.run.status !== "running" ? latest.body.run : null;
  });
  check("matching run completed", finished.status === "completed", JSON.stringify(finished));

  // 4. Ranked list: the eligible job should be ranked with a score and a fake explanation; the
  //    excluded-company job should not appear in the eligible list.
  const eligible = await call("/api/matches?eligible=true");
  check("exactly one eligible match", eligible.body.matches.length === 1, JSON.stringify(eligible.body));
  const match = eligible.body.matches[0];
  check("eligible match has an overall score", typeof match?.match?.overallScore === "number");
  check("eligible match has the fake explanation summary", match?.match?.explanation?.summary === "Fake explanation from the E2E stand-in server.");

  const ineligible = await call("/api/matches?eligible=false");
  check("excluded-company job is listed as ineligible with a reason", ineligible.body.matches.some((m: { match: { ineligibleReason: string | null } }) => m.match.ineligibleReason?.includes("Excluded Co")));

  // 5. Dismiss the eligible match and confirm a recompute keeps it ineligible.
  const dismissed = await patch(`/api/matches/${match.jobId}`, { userAction: "dismissed" });
  check("dismiss accepted", dismissed.status === 200);
  await post("/api/matches/run");
  await waitFor("second matching run to finish", async () => {
    const latest = await call("/api/matches/runs/latest");
    return latest.body.run && latest.body.run.status !== "running" ? latest.body.run : null;
  });
  const afterDismiss = await call("/api/matches?eligible=true");
  check("dismissed job no longer appears as eligible after a recompute", afterDismiss.body.total === 0, JSON.stringify(afterDismiss.body));

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("smoke test crashed:", error);
  process.exit(1);
});
```

- [ ] **Step 4: Run it manually against a scratch database**

Following the same scratch-database setup `README.md`'s "End-to-end smoke test" section already documents for `services/job-ingestion` (create `career_intel_e2e`, grant the app role, migrate it, export `DATABASE_URL`), additionally seed a candidate profile in that database (via `/profile`, since matching requires `candidate_profiles.years_of_experience`), then in four terminals from the repo root:

```bash
pnpm --filter @ai-career/matching-worker e2e:fake-anthropic
pnpm --filter @ai-career/job-ingestion start
ANTHROPIC_BASE_URL=http://localhost:4012 pnpm --filter @ai-career/matching-worker start
pnpm --filter web build && pnpm --filter web exec dotenv -e ../../.env -- next start -p 3100
```

then: `WEB_URL=http://localhost:3100 pnpm --filter @ai-career/matching-worker e2e:smoke`

Expected: every line prints `PASS`, ending with `All checks passed.`. Afterwards stop the four processes, delete the `bull:matching*` keys it left in Redis (exact keys, never flush), and drop the scratch database.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter @ai-career/matching-worker typecheck && pnpm --filter @ai-career/matching-worker lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add services/matching-worker/e2e services/matching-worker/package.json
git commit -m "test(matching-worker): end-to-end smoke test with a fake Anthropic server"
```

### Task 17: Documentation, CI check, and final verification

**Files:**
- Modify: `DECISIONS.md`, `FLOW.md`, `docs/architecture.md`, `README.md`

- [ ] **Step 1: Confirm CI needs no changes**

`.github/workflows/ci.yml` already declares Postgres+`pgvector` and Redis services, migrates the test database once before tests (D38), and passes `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL_FAST`/`EMBEDDING_PROVIDER`/`VOYAGE_API_KEY` (fake values, matching every AI-calling suite already mocking the client). `pnpm-workspace.yaml`'s `packages/*`/`services/*` globs already cover the new `packages/matching` and `services/matching-worker`, and `turbo.json`'s tasks apply to every workspace member automatically. No edits needed; verify by running `pnpm lint && pnpm typecheck` from the repo root (Step 5) and confirming both new workspaces appear in the output.

- [ ] **Step 2: DECISIONS.md**

Append these entries, dated `2026-09-22 — Phase 5 (Hybrid Matching)`:

```markdown
### D46. Skill matching reads `jobs.descriptionText` directly; no `job_requirements` table in Phase 5
**Decision:** The 30%-weighted skills factor is computed from a literal keyword hit-rate against the job's free-text title+description, blended with job↔goal semantic similarity -- not from a structured, LLM-extracted requirements table.
**Alternatives considered:** An LLM extraction step per job producing structured required/preferred terms (a `job_requirements` table).
**Why:** The roadmap's own phase list places "Requirement extraction" under Phase 6 (ATS Resume Optimization), and Phase 4 deliberately left `jobs` with no structured skill fields for the same reason (D33). Building it now would duplicate work Phase 6 needs to do more thoroughly anyway (required vs. preferred, ATS keyword coverage).
**What it affects:** `packages/matching/src/scoring/scoreSkills.ts`; Phase 6 adds `job_requirements` as new data, not a replacement.

### D47. Separate `matching-worker` process; an ineligible job is recorded, not dropped
**Decision:** `services/matching-worker` is a thin BullMQ process (mirrors `services/job-ingestion`, D32) with no scheduler -- matching only ever runs on an explicit "Find Matches" enqueue. Every job a run evaluates gets a `job_matches` row, including ineligible ones (`eligible=false` + a fixed, evidence-carrying reason).
**Alternatives considered:** A synchronous API route running eligibility, scoring and ~25 LLM calls inline; silently omitting ineligible jobs from any table.
**Why:** A run's ~25 explanation calls are too slow and rate-limit-fragile to hold an HTTP request open for (same reasoning as D17/D32's inline-vs-worker line). Recording ineligible jobs keeps eligibility explainable and browsable (CLAUDE.md §6) instead of a silent filter the user can't inspect or dispute.
**What it affects:** `services/matching-worker`, `packages/matching/src/pipeline/runMatching.ts`, `job_matches.eligible`/`ineligible_reason`.

### D48. `skillsScore` and `semanticScore` share one job↔goal embedding pair
**Decision:** A single cosine-similarity value (career-goal embedding vs. job embedding) is used twice: blended 70/30 with the literal keyword hit-rate inside `skillsScore`, and used directly, unblended, as `semanticScore`.
**Alternatives considered:** Two separate embeddings/similarity computations for the two factors.
**Why:** architecture.md §4's weight table already describes `skillsScore` as "Exact + semantic alignment" and `semanticScore` as "Overall contextual fit" -- two different roles for one signal, not two signals. A second embedding pair would double Voyage cost and pgvector storage for no accuracy gain evident in the spec.
**What it affects:** `packages/matching/src/scoring/scoreSkills.ts`, `scoreSemantic.ts`, `retrieval/fetchCandidateJobs.ts`.

### D49. Unknown data never becomes a guessed zero -- full/neutral credit or weight redistribution
**Decision:** A factor with missing input data resolves to full credit (experience/sponsorship/role/industry with nothing stated), a neutral 0.5 (unknown work mode, unknown sponsorship-when-required, no embedding yet), or `null` with its weight redistributed proportionally across the other factors (`salaryScore` only, today) -- `computeOverallScore` never treats a missing signal as a 0.
**Alternatives considered:** Defaulting an unscoreable factor to 0 (punishing missing data as if it were a bad fit).
**Why:** CLAUDE.md §6/§9 and D6's "never guess" principle apply as much to scoring as to extraction -- a job with an unparsed salary is not evidence of a bad salary, and treating it as 0 would silently punish jobs for a data-quality gap the user never asked about.
**What it affects:** every `packages/matching/src/scoring/score*.ts` function; `computeOverallScore.ts`'s redistribution.

### D50. The explanation prompt never contains raw job description or resume text
**Decision:** `generateMatchExplanation`'s input is exclusively pre-computed factor scores and short evidence strings (which skills matched/were missing, the stated experience numbers, work-mode/sponsorship state) -- never `jobs.descriptionText` or any resume content.
**Alternatives considered:** Passing the raw job description alongside the scores so the model can add color; D20's per-request random-delimiter defense (used for career-goal/resume text) applied to job content instead.
**Why:** The model's job here is narration of already-trustworthy facts, not extraction -- it needs no untrusted text at all, which is a stronger boundary than any delimiter defense (there is nothing to inject into). Matches CLAUDE.md §9's "protect against prompt injection from job descriptions."
**What it affects:** `packages/matching/src/explanation/generateMatchExplanation.ts`.

### D51. Explanation cost is bounded to the top N per run; staleness invalidates on change, not only by TTL
**Decision:** Only the top `MATCHING_EXPLAIN_TOP_N` (default 25) eligible jobs by score get an AI explanation per run. An existing explanation is regenerated when the job's `description_hash` changed, the active career goal changed, or 7 days (`MATCHING_EXPLANATION_TTL_DAYS`) have passed -- whichever comes first; a schema-invalid response leaves the row's deterministic scores untouched rather than failing the run.
**Alternatives considered:** Explaining every eligible job every run; a pure time-based TTL with no content-change invalidation; failing the whole run on one malformed explanation.
**Why:** architecture.md §7 puts match explanation on the fast/cheap tier but still bills per call; explaining hundreds of jobs on every click doesn't scale with the job catalog. A pure TTL would show a stale explanation for up to a week after the user edits their goal or a job posting changes.
**What it affects:** `packages/matching/src/explanation/explanationStaleness.ts`, `pipeline/runMatching.ts`, `MATCHING_EXPLAIN_TOP_N`/`MATCHING_EXPLANATION_TTL_DAYS`.

### D52. The career-goal embedding is generated on confirm, outside the write transaction, with a lazy fallback
**Decision:** `confirmCareerGoal` generates `career_goal_constraints.embedding` in a second, separate `withUserContext` call after the confirm transaction commits (same split saveProfile.ts uses for `profile_facts` embeddings, Phase 2). `ensureGoalEmbedding` is idempotent and is also called from `runMatching`, covering any row that reaches a matching run still unembedded.
**Alternatives considered:** Generating it inside the confirm transaction; generating it only lazily inside `runMatching` and never on confirm.
**Why:** Embedding inside the confirm transaction would hold a Postgres transaction (and RLS session setting) open for an external HTTP call, and would roll back an otherwise-valid confirm on a Voyage outage. Confirm-time generation is still the primary path so the very first "Find Matches" run does not pay that latency.
**What it affects:** `apps/web/src/lib/career-goal/saveCareerGoal.ts`, `packages/matching/src/embeddings/ensureGoalEmbedding.ts`.
```

- [ ] **Step 3: FLOW.md**

Append this section:

````markdown
## 7. Hybrid matching: confirm goal → Find Matches → ranked list (Phase 5)

```
apps/web confirmCareerGoal()                                  [existing, Phase 3]
  └─ withUserContext #1: validate, insert career_goal_constraints, activate goal
  └─ withUserContext #2 (new): ensureGoalEmbedding() -> embedTexts() -> store embedding

UI "Find Matches" button (MatchesClient.tsx)
  └─ POST /api/matches/run
        └─ check an active+confirmed career_goals row exists (409 if not)
        └─ enqueueMatching() -> BullMQ queue "matching", job id "matching-<userId>"

services/matching-worker (concurrency 1)
  └─ worker.ts: dequeues "run-matching" -> runMatching(db, { userId, anthropicClient, env })
        packages/matching/src/pipeline/runMatching.ts:
          1. load active+confirmed career_goals + its career_goal_constraints row (else MatchingError "no_active_goal")
          2. ensureGoalEmbedding()          -- fallback if confirm-time generation ever didn't run
          3. fetchCandidateJobs()           -- every open job + semantic similarity vs. the goal embedding
          4. ensureJobEmbeddings()          -- embeds any job whose embeddingContentHash != descriptionHash
          5. re-fetchCandidateJobs()        -- reflects embeddings just generated
          6. per job: evaluateEligibility() -> ineligible: upsertMatchRow(eligible=false, reason)
                                             -> eligible: scoreSkills/Experience/Location/Sponsorship/Role/Salary/Industry/Freshness/Semantic()
                                                -> computeOverallScore() -> upsertMatchRow(eligible=true, factors, overallScore)
          7. sort scored jobs desc, filter by isExplanationStale(), take top MATCHING_EXPLAIN_TOP_N
          8. per selected job: generateMatchExplanation() -> update job_matches.explanation/...
          9. finalize matching_runs (status, counts)

UI ranked list
  └─ GET /api/matches?eligible=true|false&page=N -> listMatches() -> job_matches ⋈ jobs -> MatchesClient renders MatchRow[]
  └─ GET /api/matches/[jobId] -> job_matches row + getJobDetail() [Phase 4] -> MatchDetailClient
  └─ PATCH /api/matches/[jobId] { userAction } -> job_matches.user_action/user_action_at
        (a "dismissed" row is read back as `previouslyDismissed` by the NEXT runMatching's evaluateEligibility call)
  └─ GET /api/matches/runs/latest -> most recent matching_runs row, polled by MatchesClient after "Find Matches"
```

Currently modified/added: `apps/web/src/lib/career-goal/saveCareerGoal.ts` (step 2's new embedding call); everything else in this diagram is new (`packages/matching`, `services/matching-worker`, `apps/web/src/{lib,app}/matching` and `app/api/matches/**`, `app/matches/**`).
````

- [ ] **Step 4: `docs/architecture.md`**

Change the status line at the top:
```markdown
Status: **Phases 0–5 are implemented** (foundation, candidate profile, career goal, job intelligence, hybrid matching); application generation onward is designed but not yet built. This document describes the agreed architecture as of 2026-09-06. See `DECISIONS.md` for the rationale behind each choice. Update this file as implementation reveals deviations — it must describe what's actually built, not an aspiration.
```

At the end of §4 ("Matching pipeline"), append:

```markdown
Implemented in Phase 5: eligibility (`packages/matching/src/eligibility`), hybrid retrieval (`packages/matching/src/retrieval/fetchCandidateJobs.ts` -- lexical keyword hit-rate computed in TS, semantic similarity via pgvector `<=>`), the nine weighted factors (`packages/matching/src/scoring`), and AI match reasoning bounded to the top `MATCHING_EXPLAIN_TOP_N` jobs per run (`packages/matching/src/explanation`). No structured `job_requirements` table exists yet -- skill matching reads `jobs.descriptionText` directly (D46); that extraction is Phase 6's job. See D46–D52.
```

At the end of §11 ("Job ingestion"), fix the stale forward-reference:
```markdown
- **Reading.** `GET /api/jobs` and `GET /api/jobs/[id]` power the `/jobs` browser; `/sources` manages the watch-list. Ranking, eligibility filtering and embeddings are implemented in Phase 5 (`packages/matching`, `/matches`); see §4.
```

Add a new §12:
```markdown
## 12. Hybrid matching (Phase 5)

```
career_goal_constraints (embedding, generated on confirm)  +  jobs (embedding, generated lazily on a matching run)
  │
  ▼
services/matching-worker  (BullMQ "matching" queue, concurrency 1, no scheduler -- manual trigger only)
  │  runMatching()
  ▼
deterministic eligibility  (excluded company/industry, remote-required vs. onsite/hybrid, experience gap beyond
                             a grace window, sponsorship required-but-not-offered, previously dismissed)
  │  ineligible -> job_matches row with a reason, nothing further
  ▼
nine weighted factor scores + computeOverallScore  (unknown data -> full/neutral credit or redistributed weight, never a guessed zero -- D49)
  │
  ▼
top MATCHING_EXPLAIN_TOP_N by score, whose explanation is stale or missing
  │  generateMatchExplanation()  (fast/cheap tier; only pre-computed scores/evidence in the prompt -- D50)
  ▼
job_matches  (read by GET /api/matches, GET /api/matches/[jobId]; PATCH sets user_action)
```

- **Process model.** Mirrors D32: domain logic in `packages/matching`, `services/matching-worker` is BullMQ glue only. No compose service or Dockerfile (same as `job-ingestion`); started with `pnpm --filter @ai-career/matching-worker start`.
- **Cost control.** Embeddings are permanent, content-hash-keyed caches (`jobs.embedding_content_hash`, mirrors `profile_facts`). Explanations are capped per run and invalidated only on real change, not a blind re-run (D51).
- **Known gaps carried into Phase 6+.** No structured `industry` field, so industry preference/exclusion is a company-name-substring heuristic (weak signal, never a hard block on a non-match). "Already applied" is not an eligibility rule (no applications table until Phase 9). No auto-trigger on goal confirm or ingestion completion -- "Find Matches" is manual. `MATCHING_EXPLAIN_TOP_N`, `MATCHING_EXPERIENCE_GRACE_YEARS`, `MATCHING_FRESHNESS_HALF_LIFE_HOURS` are unmeasured starting defaults.
```

- [ ] **Step 5: README.md**

Add a numbered step after the existing ingestion-worker step (step 7):
```markdown
8. Start the matching worker (needed for "Find Matches" runs):
   `pnpm --filter @ai-career/matching-worker start`. Also a plain Node
   process with no scheduler -- matching only ever runs when the `/matches`
   page's "Find Matches" button enqueues it. Run exactly one worker process
   (concurrency is 1 either way).
```

Replace the Phase 4 paragraph's last sentence in the "Status" section and add a Phase 5 paragraph:
```markdown
Phase 4 (Job Intelligence) complete: Greenhouse, Lever and CSV/JSON sources
behind a consent gate, a BullMQ ingestion worker, deterministic normalization
(salary, work mode, experience, sponsorship, posted date), three-tier
deduplication and a Sources page and read-only Jobs browser.

Phase 5 (Hybrid Matching) complete: deterministic eligibility filtering,
PostgreSQL/pg_trgm lexical + pgvector semantic hybrid retrieval, nine
weighted match factors with an explainable per-factor breakdown, and AI
match reasoning (top-ranked jobs only, evidence-grounded, never given raw
job text) via a separate matching-worker. The home page links every step
(/profile, /career-goal, /sources, /jobs, /matches). Not built yet: ATS
resume optimization (Phase 6), structured job-requirement extraction, an
`industry` field (industry matching is a company-name heuristic), and
auto-triggered recomputes.
```

- [ ] **Step 6: Update the design spec's status line**

In `docs/superpowers/specs/2026-09-22-phase-5-hybrid-matching-design.md`, change:
```markdown
Status: design, not yet implemented
```
to:
```markdown
Status: implemented; see this plan's tasks and DECISIONS.md D46-D52 for where implementation refined the design.
```

- [ ] **Step 7: Final whole-repo verification**

Run, from the repo root, in order:
```bash
pnpm install
pnpm --filter @ai-career/db db:migrate
MIGRATIONS_DATABASE_URL=postgres://career_intel:career_intel@localhost:5432/career_intel_test pnpm --filter @ai-career/db db:migrate
pnpm lint
pnpm typecheck
pnpm --filter web build
pnpm turbo run test --force
```
Expected: every command exits 0; `pnpm turbo run test --force` includes the new `@ai-career/matching` and `@ai-career/matching-worker` workspaces and shows all their suites green alongside the unchanged Phase 0–4 suites. This is the same fresh-checkout, forced (uncached), CI-order verification Phase 4 used before its first "complete" status was trusted (memory: "a genuinely fresh independent review still found real bugs the first review missed").

- [ ] **Step 8: Commit**

```bash
git add DECISIONS.md FLOW.md docs/architecture.md README.md \
        docs/superpowers/specs/2026-09-22-phase-5-hybrid-matching-design.md
git commit -m "docs: Phase 5 hybrid matching — DECISIONS D46-D52, FLOW §7, architecture §12, README"
```

## Self-review (spec coverage)

- §1 scope (eligibility, hybrid retrieval, weighted scoring, AI reasoning, `matching-worker`, API+UI) — Tasks 1–14.
- §1 out-of-scope boundary (no `job_requirements`, no "already applied" rule, no auto-trigger, no FX conversion) — respected throughout; called out explicitly in D46/D47 and this plan's Global Constraints.
- §3 data model (`job_matches`, `matching_runs`, embedding columns) — Task 3, with Refinement #1 (`explanation_description_hash`) closing the one real gap found during planning.
- §5 eligibility rules — Task 1, all five rules plus the "never hard-block on unknown" cases.
- §6 hybrid retrieval + scoring — Tasks 2, 5, 8 (all nine factors, redistribution, Refinement #2's shared-embedding decision).
- §7 AI match reasoning + staleness — Tasks 6, 7, 8 (evidence-only prompt, top-N cap, three-way staleness check).
- §8 API + UI — Tasks 10–14.
- §9 testing/security/process — a unit test per pure function, an integration test per DB/queue-touching piece, an E2E smoke test (Task 16), an AI evaluation set (Task 15), no job/resume content ever logged or prompted (D50), DECISIONS/FLOW/architecture/README updated (Task 17), CLAUDE.md §21 explain-back is this plan's final step with the user (not delegable to a task).
- §10 "assumptions to verify" — the skills-score blend ratio is fixed and unit-tested (Task 2); the industry gap is implemented as the stated heuristic (Task 2/8); the ivfflat-vs-hnsw choice is resolved at Task 3 Step 5 against the real running Postgres; `MATCHING_EXPLAIN_TOP_N`/freshness half-life ship as configurable defaults (Task 8); the goal-embedding-on-confirm edit is Task 12, called out on its own as the plan's one edit to already-shipped Phase 3 code.

No placeholders found on review; every code block above is complete and every type/signature introduced in an earlier task is used consistently by the tasks that consume it (`FactorScores`, `EligibilityResult`, `CandidateJobRow`, `MatchExplanationDraft`, `ExistingMatchRow`, `RunMatchingEnv`, `MatchingJobData` all match between producer and consumer tasks).
