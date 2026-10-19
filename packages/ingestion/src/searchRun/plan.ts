import type { schema } from "@ai-career/db";
import { companyKey } from "../normalize/keys";
import { isSearchKind } from "../types";

type SearchRunSource = schema.SearchRunSource;

const SLUG_GUESS_RE = /^[a-z0-9-]{1,63}$/;

/** Phase 13a: board slugs an employer is likely to use -- its company key joined and hyphenated. */
export function slugGuesses(name: string): string[] {
  const words = companyKey(name).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  return [...new Set([words.join(""), words.join("-")])].filter((s) => SLUG_GUESS_RE.test(s));
}

export interface RefreshCandidate {
  sourceId: string;
  name: string;
  kind: string;
  /** Finish time of the source's newest successful ingestion run. */
  lastSuccessAt: Date | null;
}

/**
 * A source is reused when it last succeeded within `freshMinutes` -- and, for a goal-driven search source, after the
 * active goal was confirmed (its results were fetched for the goal the user has now). Everything else is queued.
 */
export function planSourceRefresh(input: { sources: RefreshCandidate[]; now: Date; freshMinutes: number; goalConfirmedAt: Date | null }): SearchRunSource[] {
  const cutoff = input.now.getTime() - input.freshMinutes * 60_000;
  return input.sources.map((s) => {
    const fresh = s.lastSuccessAt !== null && input.freshMinutes > 0 && s.lastSuccessAt.getTime() >= cutoff;
    const goalChanged = isSearchKind(s.kind) && input.goalConfirmedAt !== null && s.lastSuccessAt !== null && s.lastSuccessAt < input.goalConfirmedAt;
    return { sourceId: s.sourceId, name: s.name, kind: s.kind, state: fresh && !goalChanged ? "reused" : "queued" };
  });
}

export function webSearchDue(input: {
  enabled: boolean; lastAt: Date | null; lastGoalId: string | null; goalId: string; now: Date; intervalDays: number;
}): "due" | "skipped_recent" | "skipped_disabled" {
  if (!input.enabled) return "skipped_disabled";
  if (!input.lastAt || input.lastGoalId !== input.goalId) return "due";
  return input.now.getTime() - input.lastAt.getTime() >= input.intervalDays * 86_400_000 ? "due" : "skipped_recent";
}

export interface IngestionRunUpdate {
  sourceId: string;
  status: "running" | "succeeded" | "failed";
  newCount: number;
  errorClass: string | null;
}

/**
 * Folds each queued source's newest ingestion run (started since the search run began) into its state. A `failed`
 * source is re-read every tick: BullMQ retries a transient failure, and the retry's newer row moves it on.
 */
export function applyRunUpdates(sources: SearchRunSource[], runs: IngestionRunUpdate[]): SearchRunSource[] {
  const byId = new Map(runs.map((r) => [r.sourceId, r]));
  return sources.map((s) => {
    if (s.state === "reused" || s.state === "late") return s;
    const run = byId.get(s.sourceId);
    if (!run) return s;
    const { sourceId, name, kind } = s;
    if (run.status === "running") return { sourceId, name, kind, state: "running" };
    if (run.status === "succeeded") return { sourceId, name, kind, state: "done", newCount: run.newCount };
    return { sourceId, name, kind, state: "failed", reason: run.errorClass ?? "unknown" };
  });
}

export const allSourcesSettled = (sources: SearchRunSource[]): boolean =>
  sources.every((s) => s.state !== "queued" && s.state !== "running");

export const markLate = (sources: SearchRunSource[]): SearchRunSource[] =>
  sources.map((s) => (s.state === "queued" || s.state === "running" ? { ...s, state: "late" as const } : s));
