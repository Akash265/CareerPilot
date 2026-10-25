// packages/document-export/src/model/selectTailoredResume.ts
import { containsTerm, normalizeTermKey, type AppliedBullet, type RequirementTerm } from "@ai-career/resume-optimization";
import type { DocumentBlock, DocumentModel, OmittedItem, PaperSize, RankableSourceType } from "./types";
import { contactLine, dateRange, present, type ResumeProfile } from "./resumeProfile";
import { certificationBlocks, educationBlocks, joinPresent } from "./resumeSections";
import { estimateLines, lineBudget, LINE_METRICS } from "./estimateLines";

export interface TailoredSelection {
  model: DocumentModel;
  includedCount: number;
  totalCount: number;
  /** Rankable items in profile order, then skills / verified terms that did not fit the skills line. Counts above cover rankable items only. */
  omitted: OmittedItem[];
  /** True when every remaining rankable item is protected by a floor (nothing more can be removed). */
  exhausted: boolean;
  /**
   * Cut rankable items, best-ranked first, each with the estimated lines it would add back (its own lines plus a
   * section heading it would bring back). fitToPage tries them against the real page's free space (D217).
   */
  refill: RefillCandidate[];
}

export interface RefillCandidate { key: string; addedLines: number }

export interface SelectTailoredOptions {
  paperSize: PaperSize;
  /** Items to remove beyond the estimate fit -- the compile loop's lever (fitToPage). */
  extraRemovals?: number;
  /** Item keys ("<sourceType>:<id>") the real compile showed still fit; put back after all removals (D217). */
  include?: ReadonlySet<string>;
}

const REQUIRED_WEIGHT = 2;
const PREFERRED_WEIGHT = 1;
const SKILLS_MAX_LINES = 2;
const FLOOR_RECENT_ROLES = 2;

interface Requirement { key: string; lower: string; weight: number }

interface Item {
  key: string;
  sourceType: RankableSourceType;
  id: string;
  text: string;
  selectedRank: number | null;
  score: number;
  profileOrder: number;
  roleIndex: number | null;
}

/** Non-blank terms, one per normalized key at its highest weight; required before preferred, then input order. */
function dedupeRequirements(requirements: RequirementTerm[]): Requirement[] {
  const byKey = new Map<string, Requirement>();
  for (const r of requirements) {
    if (!present(r.termText)) continue;
    const key = normalizeTermKey(r.termText);
    const weight = r.requirementLevel === "required" ? REQUIRED_WEIGHT : PREFERRED_WEIGHT;
    const prev = byKey.get(key);
    if (!prev || weight > prev.weight) byKey.set(key, { key, lower: r.termText.trim().toLowerCase(), weight });
  }
  return [...byKey.values()].sort((a, b) => b.weight - a.weight);
}

/** Selected (optimizer order) first; then requirement score descending; then profile order. */
function compareRank(a: Item, b: Item): number {
  if (a.selectedRank !== null && b.selectedRank !== null) return a.selectedRank - b.selectedRank;
  if (a.selectedRank !== null) return -1;
  if (b.selectedRank !== null) return 1;
  return b.score - a.score || a.profileOrder - b.profileOrder;
}

function assertKnownApplied(profile: ResumeProfile, applied: AppliedBullet[]): void {
  const knownIds = new Set<string>([
    ...profile.experiences.flatMap((e) => e.bullets.map((b) => `work_experience_bullet:${b.id}`)),
    ...profile.achievements.map((a) => `achievement:${a.id}`),
    ...profile.projects.map((p) => `project:${p.id}`),
    ...profile.certifications.map((c) => `certification:${c.id}`),
    ...profile.education.map((e) => `education:${e.id}`),
    ...profile.skills.map((s) => `skill:${s.id}`),
    ...profile.verifiedSkills.map((v) => `verified_skill:${v.id}`),
  ]);
  for (const a of applied) {
    if (!knownIds.has(`${a.sourceType}:${a.sourceFactId}`)) throw new Error(`applied bullet cites unknown source fact ${a.sourceFactId}`);
  }
}

interface SkillsLine { names: string[]; omitted: OmittedItem[] }

/** The skills line (2-line cap) and the skills / verified terms that did not fit (deduped terms are neither). */
function skillsLine(profile: ResumeProfile, requirements: Requirement[], paperSize: PaperSize): SkillsLine {
  const all: { name: string; sourceType: "skill" | "verified_skill"; id: string }[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...profile.skills.map((s) => ({ name: s.name, sourceType: "skill" as const, id: s.id })),
    ...profile.verifiedSkills.map((v) => ({ name: v.term, sourceType: "verified_skill" as const, id: v.id })),
  ];
  for (const c of candidates) {
    if (!present(c.name)) continue;
    const key = normalizeTermKey(c.name);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(c);
  }
  const reqOrder = new Map(requirements.map((r, i) => [r.key, i]));
  const order = (name: string) => reqOrder.get(normalizeTermKey(name));
  const matched = all.filter((c) => order(c.name) !== undefined).sort((a, b) => order(a.name)! - order(b.name)!);
  const rest = all.filter((c) => order(c.name) === undefined);
  const cap = SKILLS_MAX_LINES * LINE_METRICS[paperSize].charsPerLine;
  const names: string[] = [];
  const omittedIds = new Set<string>();
  let length = 0;
  for (const c of [...matched, ...rest]) {
    const add = (names.length > 0 ? 2 : 0) + c.name.length;
    if (length + add > cap) {
      omittedIds.add(`${c.sourceType}:${c.id}`);
      continue;
    }
    names.push(c.name);
    length += add;
  }
  const omitted = all
    .filter((c) => omittedIds.has(`${c.sourceType}:${c.id}`))
    .map((c): OmittedItem => ({ sourceType: c.sourceType, sourceFactId: c.id, reason: "page_limit" }));
  return { names, omitted };
}

/**
 * The tailored resume (Phase 13c spec §3, D207): the optimizer's guard-applied rewordings first, the rest ranked by
 * the job's requirement terms, trimmed to one estimated page without breaking the floors. Deterministic; no text is
 * written here -- every string is the optimizer's guard-applied text or the profile's own.
 */
export function selectTailoredResume(
  profile: ResumeProfile, applied: AppliedBullet[], requirementTerms: RequirementTerm[], opts: SelectTailoredOptions
): TailoredSelection {
  assertKnownApplied(profile, applied);
  const requirements = dedupeRequirements(requirementTerms);
  const appliedByKey = new Map<string, { rank: number; optimizedText: string }>();
  applied.forEach((a, index) => {
    const key = `${a.sourceType}:${a.sourceFactId}`;
    if (!appliedByKey.has(key)) appliedByKey.set(key, { rank: index, optimizedText: a.optimizedText }); // first occurrence wins
  });

  const items: Item[] = [];
  const add = (sourceType: RankableSourceType, id: string, original: string, roleIndex: number | null) => {
    const key = `${sourceType}:${id}`;
    const a = appliedByKey.get(key);
    const text = a && present(a.optimizedText) ? a.optimizedText : original;
    const lower = text.toLowerCase();
    const score = requirements.reduce((sum, r) => sum + (containsTerm(lower, r.lower) ? r.weight : 0), 0);
    items.push({ key, sourceType, id, text, selectedRank: a?.rank ?? null, score, profileOrder: items.length, roleIndex });
  };
  profile.experiences.forEach((exp, roleIndex) => exp.bullets.forEach((b) => add("work_experience_bullet", b.id, b.text, roleIndex)));
  profile.projects.forEach((p) => add("project", p.id, p.description, null));
  profile.achievements.forEach((a) => add("achievement", a.id, a.description, null));

  const ranked = [...items].sort(compareRank);
  const isIrrelevant = (i: Item) => i.selectedRank === null && i.score === 0;
  // Floors (D216, amends D207): the two most recent roles keep their top 2 bullets; an older role keeps its top bullet
  // only when it is relevant (optimizer-selected or matching a requirement), else it may shrink to its header.
  const isProtected = new Set<string>();
  profile.experiences.forEach((_, roleIndex) => {
    const floor = roleIndex < FLOOR_RECENT_ROLES ? 2 : 1;
    ranked
      .filter((i) => i.roleIndex === roleIndex)
      .slice(0, floor)
      .filter((i) => roleIndex < FLOOR_RECENT_ROLES || !isIrrelevant(i))
      .forEach((i) => isProtected.add(i.key));
  });
  const worstFirst = [...ranked].reverse().filter((i) => !isProtected.has(i.key));
  const removalQueue = [
    ...worstFirst.filter((i) => i.sourceType !== "work_experience_bullet" && isIrrelevant(i)),
    ...worstFirst.filter((i) => !(i.sourceType !== "work_experience_bullet" && isIrrelevant(i))),
  ];

  const { names: skills, omitted: omittedSkills } = skillsLine(profile, requirements, opts.paperSize);
  const projectsById = new Map(profile.projects.map((p) => [p.id, p]));

  const build = (removed: Set<string>): DocumentModel => {
    const kept = (filter: (i: Item) => boolean) => items.filter((i) => filter(i) && !removed.has(i.key)).sort(compareRank);
    const blocks: DocumentBlock[] = [];
    if (profile.experiences.length > 0) {
      blocks.push({ type: "heading", text: "Experience" });
      profile.experiences.forEach((exp, roleIndex) => {
        blocks.push({ type: "entry", title: exp.title, subtitle: joinPresent([exp.company, exp.location]), meta: dateRange(exp.startDate, exp.endDate) });
        const bullets = kept((i) => i.roleIndex === roleIndex);
        if (bullets.length > 0) blocks.push({ type: "bullets", items: bullets.map((i) => i.text) });
      });
    }
    const projects = kept((i) => i.sourceType === "project");
    if (projects.length > 0) {
      blocks.push({ type: "heading", text: "Projects" });
      for (const i of projects) {
        const p = projectsById.get(i.id)!;
        blocks.push({ type: "entry", title: p.name, subtitle: present(p.url) ? p.url : null, meta: null });
        blocks.push({ type: "paragraph", text: i.text });
      }
    }
    const achievements = kept((i) => i.sourceType === "achievement");
    if (achievements.length > 0) {
      blocks.push({ type: "heading", text: "Achievements" });
      blocks.push({ type: "bullets", items: achievements.map((i) => i.text) });
    }
    blocks.push(...educationBlocks(profile), ...certificationBlocks(profile));
    if (skills.length > 0) {
      blocks.push({ type: "heading", text: "Skills" });
      blocks.push({ type: "paragraph", text: skills.join(", ") });
    }
    return { title: profile.contact.fullName, contactLine: contactLine(profile.contact), blocks };
  };

  const removed = new Set<string>();
  const budget = lineBudget(opts.paperSize);
  let next = 0;
  let model = build(removed);
  while (estimateLines(model, opts.paperSize) > budget && next < removalQueue.length) {
    removed.add(removalQueue[next++].key);
    model = build(removed);
  }
  // One greedy refill pass (best-ranked first): the last removal may have been large enough that smaller,
  // lower-ranked items removed earlier fit again.
  if (removed.size > 0) {
    for (const item of ranked.filter((i) => removed.has(i.key))) {
      removed.delete(item.key);
      const candidate = build(removed);
      if (estimateLines(candidate, opts.paperSize) <= budget) model = candidate;
      else removed.add(item.key);
    }
  }
  // Extra removals take the worst-ranked removable items still included (queue order); floor items are not in the queue.
  const nextIncluded = () => removalQueue.find((i) => !removed.has(i.key));
  for (let n = 0; n < (opts.extraRemovals ?? 0); n++) {
    const item = nextIncluded();
    if (!item) break;
    removed.add(item.key);
    model = build(removed);
  }
  // Items the compile loop confirmed on the real page come back last, so every other removal stays as it was.
  if (opts.include && opts.include.size > 0) {
    for (const key of opts.include) removed.delete(key);
    model = build(removed);
  }
  const exhausted = nextIncluded() === undefined;

  const lines = estimateLines(model, opts.paperSize);
  const refill: RefillCandidate[] = ranked
    .filter((i) => removed.has(i.key))
    .map((i) => {
      const without = new Set(removed);
      without.delete(i.key);
      return { key: i.key, addedLines: estimateLines(build(without), opts.paperSize) - lines };
    });

  const omittedRankable: OmittedItem[] = items
    .filter((i) => removed.has(i.key))
    .map((i) => ({ sourceType: i.sourceType, sourceFactId: i.id, reason: isIrrelevant(i) ? "no_requirement_match" : "page_limit" }));
  const omitted = [...omittedRankable, ...omittedSkills];
  return { model, includedCount: items.length - removed.size, totalCount: items.length, omitted, exhausted, refill };
}
