const ACTION_VERBS = [
  "led", "built", "designed", "implemented", "developed", "created", "managed", "launched",
  "improved", "reduced", "increased", "optimized", "architected", "automated", "delivered",
  "drove", "established", "owned", "scaled", "streamlined", "spearheaded", "mentored",
  "analyzed", "engineered", "migrated", "deployed", "coordinated", "negotiated", "resolved",
];

const MIN_BULLET_WORDS = 4;
const MAX_BULLET_WORDS = 40;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function startsWithActionVerb(text: string): boolean {
  const firstWord = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  return ACTION_VERBS.includes(firstWord);
}

function isWellSizedBullet(text: string): boolean {
  const count = wordCount(text);
  return count >= MIN_BULLET_WORDS && count <= MAX_BULLET_WORDS;
}

export interface ReadabilityResult {
  actionVerbScore: number;
  machineReadabilityScore: number;
}

/**
 * Rule-based, not LLM-judged (design doc §7 decision 5). actionVerbScore is the fraction of
 * work_experience_bullet entries among the applied bullets that open with a curated action verb --
 * other evidence types (skills, education, certifications) are excluded from its denominator, since
 * they're not meant to read as accomplishment statements. machineReadabilityScore is the fraction of
 * ALL applied entries within a sane word-count range, catching both a truncated fragment and an
 * unreadable run-on.
 */
export function scoreActionVerbsAndReadability(
  appliedBullets: { sourceType: string; optimizedText: string }[]
): ReadabilityResult {
  const experienceBullets = appliedBullets.filter((b) => b.sourceType === "work_experience_bullet");
  const actionVerbScore =
    experienceBullets.length === 0
      ? 1
      : experienceBullets.filter((b) => startsWithActionVerb(b.optimizedText)).length / experienceBullets.length;

  const machineReadabilityScore =
    appliedBullets.length === 0
      ? 1
      : appliedBullets.filter((b) => isWellSizedBullet(b.optimizedText)).length / appliedBullets.length;

  return { actionVerbScore, machineReadabilityScore };
}
