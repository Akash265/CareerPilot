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
 * Nothing runs without the standing consent. Auto-discovery gates link-mining (1) and boards found that way; boards
 * the user pasted (found via no source) are their own choice, validate whenever there is consent, and become manual
 * sources -- so switching auto-discovery off later never disables them.
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

/** After a transient failure a board waits this long before it is tried again. */
const RETRY_AFTER_MS = 60 * 60 * 1000;
/** A board still failing transiently this long after it was found is given up on. */
const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Pending rows one pass looks at (oldest first); the rest wait for later passes. */
const PENDING_PAGE = 500;
/** Answers that say the board will not work: it does not exist, refuses us, or is not a job board we can read. */
const REJECTING = new Set(["not_found", "invalid_slug", "http_error", "response_too_large"]);

export async function validatePendingBoards(db: DbClient, opts: ValidateOptions): Promise<ValidateResult> {
  const now = opts.now ?? (() => new Date());
  const inUser = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, opts.userId, fn);
  const { settings, pending, total, existing } = await inUser(async (tx) => ({
    settings: await settingsOf(tx),
    pending: await tx.select().from(discoveredBoards).where(eq(discoveredBoards.status, "pending")).orderBy(asc(discoveredBoards.firstSeenAt)).limit(PENDING_PAGE),
    total: (await tx.select({ n: count() }).from(discoveredBoards).where(eq(discoveredBoards.status, "pending")))[0].n,
    // Only enabled discovered sources use up the cap: ones switched off with auto-discovery do not block new ones.
    existing: (await tx.select({ n: count() }).from(jobSources).where(and(eq(jobSources.origin, "discovered"), eq(jobSources.enabled, true))))[0].n,
  }));
  const result: ValidateResult = { enabled: 0, rejected: 0, pending: total };
  if (!settings?.consentedAt) return result;

  // maxPerRun bounds the fetches of one pass (politeness) -- every attempt counts, failed or not; maxSources bounds
  // only what discovery adds on its own.
  let fetches = opts.maxPerRun;
  let discoveredRoom = Math.max(0, opts.maxSources - existing);
  const reject = async (id: string) => {
    await inUser((tx) => tx.update(discoveredBoards).set({ status: "rejected", checkedAt: now() }).where(eq(discoveredBoards.id, id)));
    result.rejected++;
    result.pending--;
  };
  for (const board of pending) {
    if (fetches <= 0) break;
    const pasted = board.foundViaSourceId === null;
    if (!pasted && (!settings.autoDiscover || discoveredRoom <= 0)) continue;
    if (board.checkedAt && now().getTime() - board.checkedAt.getTime() < RETRY_AFTER_MS) continue; // backing off
    fetches--;
    const ref: SourceRef = { id: board.id, kind: board.kind as BoardKind, label: board.slug, config: { slug: board.slug } };
    let record: RawRecord | null;
    try {
      record = await firstRecord(opts.adapterFor(ref), ref);
    } catch (error) {
      const errorClass = error instanceof IngestError ? error.errorClass : "unknown";
      if (REJECTING.has(errorClass) || now().getTime() - board.firstSeenAt.getTime() > GIVE_UP_AFTER_MS) {
        await reject(board.id);
      } else {
        // Transient (network, rate limit, timeout, server error, an unexpected shape): try again after a while.
        await inUser((tx) => tx.update(discoveredBoards).set({ checkedAt: now() }).where(eq(discoveredBoards.id, board.id)));
      }
      continue;
    }
    if (!record) {
      await reject(board.id);
      continue;
    }
    let label = board.slug;
    try {
      label = normalizeRecord(ref, record).companyName; // falls back to the slug when the board names no company
    } catch {
      // An unreadable first record still proves the board exists; the slug names it.
    }
    const created = await inUser(async (tx) => {
      // A pass can take minutes: re-read the settings in the same transaction as the insert, so a withdrawn consent
      // (or auto-discovery switched off) mid-pass creates nothing. FOR SHARE holds off a concurrent change until commit.
      const [current] = await tx.select().from(discoverySettings).for("share");
      if (!current?.consentedAt || (!pasted && !current.autoDiscover)) return false;
      const [source] = await tx
        .insert(jobSources)
        .values({
          kind: board.kind, origin: pasted ? "manual" : "discovered", label, config: { slug: board.slug },
          enabled: true, consentConfirmedAt: current.consentedAt,
        })
        .onConflictDoNothing() // the user already added this board by hand
        .returning({ id: jobSources.id });
      await tx.update(discoveredBoards).set({ status: "enabled", sourceId: source?.id ?? null, checkedAt: now() }).where(eq(discoveredBoards.id, board.id));
      return true;
    });
    if (!created) break; // consent or auto-discovery is gone: stop the pass
    result.enabled++;
    result.pending--;
    if (!pasted) discoveredRoom--;
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
