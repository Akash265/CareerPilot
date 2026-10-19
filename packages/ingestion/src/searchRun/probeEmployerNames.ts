import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { BOARD_KINDS } from "../types";
import { companyKey } from "../normalize/keys";
import { insertPendingBoards, type PendingBoard } from "../discovery/discover";
import { slugGuesses } from "./plan";

const { discoveredBoards, discoverySettings, jobMatches, jobPostings, jobSources, jobs } = schema;
const LOOKBACK_DAYS = 14;

/**
 * Phase 13a: employers that appeared in goal-driven search results (aggregators) may run their own board on one of
 * the six supported platforms. Each name not tried before becomes slug guesses on every platform, as pending boards
 * (`name_probe`), validated and company-checked by validatePendingBoards. Names are ordered by how well their job
 * matched the goal's roles. A (kind, slug) already recorded -- even rejected -- is never inserted again.
 */
export async function probeEmployerNames(
  tx: DbClient, opts: { now: Date; maxNames: number },
): Promise<{ names: number; boardsQueued: number }> {
  const [settings] = await tx.select().from(discoverySettings).limit(1);
  if (!settings?.consentedAt || !settings.autoDiscover || opts.maxNames <= 0) return { names: 0, boardsQueued: 0 };

  const since = new Date(opts.now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const rows = await tx
    .select({ name: jobs.companyName })
    .from(jobs)
    .innerJoin(jobPostings, eq(jobPostings.jobId, jobs.id))
    .innerJoin(jobSources, eq(jobSources.id, jobPostings.sourceId))
    .leftJoin(jobMatches, eq(jobMatches.jobId, jobs.id))
    .where(and(eq(jobSources.origin, "search"), gte(jobs.firstSeenAt, since)))
    .groupBy(jobs.companyName)
    .orderBy(sql`max(${jobMatches.roleScore}) DESC NULLS LAST`, jobs.companyName);

  const tried = new Set(
    (await tx.select({ expected: discoveredBoards.expectedCompany }).from(discoveredBoards)
      .where(inArray(discoveredBoards.foundVia, ["name_probe", "web_search"])))
      .map((r) => companyKey(r.expected ?? "")),
  );
  const ownBoards = new Set(
    (await tx.select({ label: jobSources.label }).from(jobSources).where(inArray(jobSources.kind, [...BOARD_KINDS])))
      .map((r) => companyKey(r.label)),
  );

  const picked: string[] = [];
  const seenKeys = new Set<string>();
  for (const { name } of rows) {
    const key = companyKey(name);
    if (!key || tried.has(key) || ownBoards.has(key) || seenKeys.has(key)) continue;
    if (slugGuesses(name).length === 0) continue;
    seenKeys.add(key);
    picked.push(name);
    if (picked.length >= opts.maxNames) break;
  }
  const links: PendingBoard[] = picked.flatMap((name) =>
    slugGuesses(name).flatMap((slug) => BOARD_KINDS.map((kind) => ({ kind, slug, expectedCompany: name }))));
  const boardsQueued = await insertPendingBoards(tx, links, { foundVia: "name_probe" });
  return { names: picked.length, boardsQueued };
}
