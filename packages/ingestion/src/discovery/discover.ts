import { and, asc, count, desc, eq, gte } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { normalizeRecord } from "../normalize/normalizeRecord";
import { IngestError, type BoardKind, type RawRecord, type SourceAdapter, type SourceRef } from "../types";
import { extractBoardLinks } from "./boardLinks";

const { discoveredBoards, discoverySettings, jobSources, rawJobPostings, ingestionRuns } = schema;

/**
 * Phase 12 (D185, D186): automatic company discovery.
 * 1. recordBoardsFromRun -- after a run, every board linked from that run's raw records becomes a `pending` row.
 * 2. validatePendingBoards -- one fetch per pending board: jobs → an enabled, discovered source; none → rejected.
 * 3. retireIfGone -- a discovered source whose board is gone twice in a row is disabled.
 * Nothing runs without the standing consent, and 1-2 also need auto-discovery switched on.
 */

async function settingsOf(tx: DbClient): Promise<{ autoDiscover: boolean; consentedAt: Date | null } | null> {
  const [row] = await tx.select().from(discoverySettings).limit(1);
  return row ? { autoDiscover: row.autoDiscover, consentedAt: row.consentedAt } : null;
}

/** Inserts each link as a pending board (once per kind + slug, whatever the case). Returns how many were new. */
export async function insertPendingBoards(
  tx: DbClient, links: { kind: BoardKind; slug: string }[], foundViaSourceId: string | null,
): Promise<number> {
  if (links.length === 0) return 0;
  const inserted = await tx
    .insert(discoveredBoards)
    .values(links.map((l) => ({ kind: l.kind, slug: l.slug, foundViaSourceId })))
    .onConflictDoNothing()
    .returning({ id: discoveredBoards.id });
  return inserted.length;
}

/**
 * Every string value inside a payload. Scanning JSON.stringify output would see a quote inside an href as `\"`,
 * and a link would then end in a backslash instead of at its closing quote.
 */
function stringsIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out, depth + 1);
  return out;
}

export async function recordBoardsFromRun(
  db: DbClient, opts: { userId: string; sourceId: string; since: Date },
): Promise<number> {
  return withUserContext(db, opts.userId, async (tx) => {
    const settings = await settingsOf(tx);
    if (!settings?.consentedAt || !settings.autoDiscover) return 0;
    const rows = await tx
      .select({ payload: rawJobPostings.payload })
      .from(rawJobPostings)
      .where(and(eq(rawJobPostings.sourceId, opts.sourceId), gte(rawJobPostings.fetchedAt, opts.since)));
    // Boards the user already has as sources (added by hand, discovered, or this run's own) are not new.
    const known = new Set(
      (await tx.select({ kind: jobSources.kind, config: jobSources.config }).from(jobSources))
        .filter((s) => s.config.slug).map((s) => `${s.kind}:${s.config.slug!.toLowerCase()}`),
    );
    const links = extractBoardLinks(rows.map((r) => stringsIn(r.payload).join("\n")).join("\n"))
      .filter((l) => !known.has(`${l.kind}:${l.slug.toLowerCase()}`));
    return insertPendingBoards(tx, links, opts.sourceId);
  });
}

export interface ValidateOptions {
  userId: string;
  adapterFor: (source: SourceRef) => SourceAdapter;
  /** Total discovered sources allowed (DISCOVERY_MAX_SOURCES). */
  maxSources: number;
  /** Boards validated in one call (DISCOVERY_MAX_NEW_PER_RUN). */
  maxPerRun: number;
  now?: () => Date;
}

export interface ValidateResult {
  enabled: number;
  rejected: number;
  /** Still waiting: over a limit, or the fetch failed for a reason that may pass. */
  pending: number;
}

/** Fetches a board just far enough to see one job. Null: it does not exist or has none. */
async function firstRecord(adapter: SourceAdapter, ref: SourceRef): Promise<RawRecord | null> {
  for await (const record of adapter.fetch(ref)) return record;
  return null;
}

export async function validatePendingBoards(db: DbClient, opts: ValidateOptions): Promise<ValidateResult> {
  const now = opts.now ?? (() => new Date());
  const inUser = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, opts.userId, fn);
  const { settings, pending, existing } = await inUser(async (tx) => ({
    settings: await settingsOf(tx),
    pending: await tx.select().from(discoveredBoards).where(eq(discoveredBoards.status, "pending")).orderBy(asc(discoveredBoards.firstSeenAt)),
    existing: (await tx.select({ n: count() }).from(jobSources).where(eq(jobSources.origin, "discovered")))[0].n,
  }));
  const result: ValidateResult = { enabled: 0, rejected: 0, pending: pending.length };
  if (!settings?.consentedAt || !settings.autoDiscover) return result;

  let room = Math.min(opts.maxPerRun, Math.max(0, opts.maxSources - existing));
  for (const board of pending) {
    if (room <= 0) break;
    const ref: SourceRef = { id: board.id, kind: board.kind as BoardKind, label: board.slug, config: { slug: board.slug } };
    let record: RawRecord | null;
    try {
      record = await firstRecord(opts.adapterFor(ref), ref);
    } catch (error) {
      const gone = error instanceof IngestError && (error.errorClass === "not_found" || error.errorClass === "invalid_slug" || error.errorClass === "schema_mismatch");
      if (!gone) {
        // Transient (network, rate limit, server error): try again on a later pass.
        await inUser((tx) => tx.update(discoveredBoards).set({ checkedAt: now() }).where(eq(discoveredBoards.id, board.id)));
        continue;
      }
      record = null;
    }
    room--;
    if (!record) {
      await inUser((tx) => tx.update(discoveredBoards).set({ status: "rejected", checkedAt: now() }).where(eq(discoveredBoards.id, board.id)));
      result.rejected++;
      result.pending--;
      continue;
    }
    let label = board.slug;
    try {
      label = normalizeRecord(ref, record).companyName; // falls back to the slug when the board names no company
    } catch {
      // An unreadable first record still proves the board exists; the slug names it.
    }
    await inUser(async (tx) => {
      const [source] = await tx
        .insert(jobSources)
        .values({
          kind: board.kind, origin: "discovered", label, config: { slug: board.slug },
          enabled: true, consentConfirmedAt: settings.consentedAt,
        })
        .onConflictDoNothing() // the user already added this board by hand
        .returning({ id: jobSources.id });
      await tx.update(discoveredBoards).set({ status: "enabled", sourceId: source?.id ?? null, checkedAt: now() }).where(eq(discoveredBoards.id, board.id));
    });
    result.enabled++;
    result.pending--;
  }
  return result;
}

/** A discovered board whose last two runs both found nothing at the address is gone: stop fetching it. */
export async function retireIfGone(db: DbClient, opts: { userId: string; sourceId: string }): Promise<boolean> {
  return withUserContext(db, opts.userId, async (tx) => {
    const [source] = await tx.select({ origin: jobSources.origin }).from(jobSources).where(eq(jobSources.id, opts.sourceId));
    if (source?.origin !== "discovered") return false;
    const runs = await tx
      .select({ errorClass: ingestionRuns.errorClass })
      .from(ingestionRuns)
      .where(eq(ingestionRuns.sourceId, opts.sourceId))
      .orderBy(desc(ingestionRuns.startedAt))
      .limit(2);
    if (runs.length < 2 || runs.some((r) => r.errorClass !== "not_found")) return false;
    await tx.update(jobSources).set({ enabled: false }).where(eq(jobSources.id, opts.sourceId));
    await tx.update(discoveredBoards).set({ status: "gone" }).where(eq(discoveredBoards.sourceId, opts.sourceId));
    return true;
  });
}
