import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { schema, type DbClient } from "@ai-career/db";
import { extractBoardLinks, insertPendingBoards, type SearchKind } from "@ai-career/ingestion";
import { SOURCE_KIND_LABELS } from "../job-sources/kindLabels";

const { discoveredBoards, discoverySettings, jobSources } = schema;

/** Phase 12 (D185-D187): the search providers, in the order the page shows them, and the env keys each needs. */
export const SEARCH_PROVIDERS: { kind: SearchKind; keys: string[] }[] = [
  { kind: "remotive", keys: [] },
  { kind: "remoteok", keys: [] },
  { kind: "arbeitnow", keys: [] },
  { kind: "themuse", keys: [] },
  { kind: "hn_hiring", keys: [] },
  { kind: "adzuna", keys: ["ADZUNA_APP_ID", "ADZUNA_APP_KEY"] },
  { kind: "jooble", keys: ["JOOBLE_API_KEY"] },
  { kind: "usajobs", keys: ["USAJOBS_API_KEY", "USAJOBS_USER_AGENT"] },
];

export type KeyEnv = Partial<Record<string, unknown>>;
const missingKeys = (env: KeyEnv, keys: string[]) => keys.filter((k) => env[k] === undefined || env[k] === "");

export const SettingsBodySchema = z.object({ consent: z.boolean(), autoDiscover: z.boolean() }).strict();
export const ProviderBodySchema = z.object({ enabled: z.boolean() }).strict();
export const BoardsBodySchema = z.object({ text: z.string().min(1, "Paste at least one board link").max(100_000) }).strict();

const BOARD_STATUSES = ["pending", "enabled", "rejected", "gone"] as const;

export interface DiscoveryView {
  settings: { consentedAt: string | null; autoDiscover: boolean };
  providers: { kind: SearchKind; label: string; keyRequired: boolean; keyConfigured: boolean; missingKeys: string[]; enabled: boolean; sourceId: string | null }[];
  boards: {
    counts: Record<(typeof BOARD_STATUSES)[number], number>;
    recent: { kind: string; slug: string; status: string; label: string | null; foundVia: string | null; firstSeenAt: string }[];
  };
}

async function settingsRow(tx: DbClient) {
  const [row] = await tx.select().from(discoverySettings).limit(1);
  return row ?? null;
}

export async function loadDiscoveryView(tx: DbClient, env: KeyEnv): Promise<DiscoveryView> {
  const settings = await settingsRow(tx);
  const searchSources = await tx.select().from(jobSources).where(eq(jobSources.origin, "search"));
  const counts = Object.fromEntries(BOARD_STATUSES.map((s) => [s, 0])) as DiscoveryView["boards"]["counts"];
  for (const row of await tx.select({ status: discoveredBoards.status, n: count() }).from(discoveredBoards).groupBy(discoveredBoards.status)) {
    counts[row.status] = row.n;
  }
  const recent = await tx.select().from(discoveredBoards).orderBy(desc(discoveredBoards.firstSeenAt)).limit(50);
  const ids = [...new Set(recent.flatMap((b) => [b.sourceId, b.foundViaSourceId]).filter((x): x is string => x !== null))];
  const labels = new Map(
    ids.length ? (await tx.select({ id: jobSources.id, label: jobSources.label }).from(jobSources).where(inArray(jobSources.id, ids))).map((r) => [r.id, r.label]) : [],
  );
  return {
    settings: { consentedAt: settings?.consentedAt?.toISOString() ?? null, autoDiscover: settings?.autoDiscover ?? false },
    providers: SEARCH_PROVIDERS.map((p) => {
      const source = searchSources.find((s) => s.kind === p.kind);
      const missing = missingKeys(env, p.keys);
      return {
        kind: p.kind, label: SOURCE_KIND_LABELS[p.kind], keyRequired: p.keys.length > 0, keyConfigured: missing.length === 0,
        missingKeys: missing, enabled: source?.enabled ?? false, sourceId: source?.id ?? null,
      };
    }),
    boards: {
      counts,
      recent: recent.map((b) => ({
        kind: b.kind, slug: b.slug, status: b.status,
        label: b.sourceId ? labels.get(b.sourceId) ?? null : null,
        foundVia: b.foundViaSourceId ? labels.get(b.foundViaSourceId) ?? null : null,
        firstSeenAt: b.firstSeenAt.toISOString(),
      })),
    },
  };
}

/**
 * The standing consent (D185). Consent is recorded once and kept; withdrawing it switches off auto-discovery and
 * every discovered and search source. Switching auto-discovery off disables the sources it found (data is kept), and
 * switching it back on re-enables those that are still live.
 */
export async function applySettings(tx: DbClient, body: z.infer<typeof SettingsBodySchema>, now: Date): Promise<string | null> {
  if (body.autoDiscover && !body.consent) return "Give permission before switching on automatic discovery";
  const current = await settingsRow(tx);
  const consentedAt = body.consent ? current?.consentedAt ?? now : null;
  await tx
    .insert(discoverySettings)
    .values({ autoDiscover: body.autoDiscover, consentedAt, updatedAt: now })
    .onConflictDoUpdate({ target: discoverySettings.userId, set: { autoDiscover: body.autoDiscover, consentedAt, updatedAt: now } });
  if (!body.autoDiscover) await tx.update(jobSources).set({ enabled: false }).where(eq(jobSources.origin, "discovered"));
  // Switching it back on restores what switching it off disabled -- every discovered board still live -- but never a
  // board retired as gone (its discovered_boards row is no longer 'enabled').
  if (body.autoDiscover && !current?.autoDiscover) {
    const live = tx.select({ id: discoveredBoards.sourceId }).from(discoveredBoards).where(eq(discoveredBoards.status, "enabled"));
    await tx.update(jobSources).set({ enabled: true }).where(and(eq(jobSources.origin, "discovered"), inArray(jobSources.id, live)));
  }
  if (!body.consent) await tx.update(jobSources).set({ enabled: false }).where(eq(jobSources.origin, "search"));
  return null;
}

export type ProviderResult = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

export async function setProvider(tx: DbClient, kind: string, enabled: boolean, env: KeyEnv, now: Date): Promise<ProviderResult> {
  const provider = SEARCH_PROVIDERS.find((p) => p.kind === kind);
  if (!provider) return { ok: false, status: 404, error: "Unknown search provider" };
  const [existing] = await tx.select().from(jobSources).where(and(eq(jobSources.origin, "search"), eq(jobSources.kind, provider.kind)));
  if (!enabled) {
    if (existing) await tx.update(jobSources).set({ enabled: false }).where(eq(jobSources.id, existing.id));
    return { ok: true };
  }
  const settings = await settingsRow(tx);
  if (!settings?.consentedAt) return { ok: false, status: 409, error: "Give permission for discovery on this page first" };
  const missing = missingKeys(env, provider.keys);
  if (missing.length) return { ok: false, status: 400, error: `Set ${missing.join(" and ")} in .env to use ${SOURCE_KIND_LABELS[provider.kind]}` };
  if (existing) {
    await tx.update(jobSources).set({ enabled: true, consentConfirmedAt: existing.consentConfirmedAt ?? settings.consentedAt }).where(eq(jobSources.id, existing.id));
  } else {
    await tx.insert(jobSources).values({
      kind: provider.kind, origin: "search", label: SOURCE_KIND_LABELS[provider.kind], enabled: true, consentConfirmedAt: settings.consentedAt, createdAt: now,
    });
  }
  return { ok: true };
}

export type ImportResult = { ok: true; recognized: number; added: number } | { ok: false; status: 409; error: string };

/** Pasted board links become pending boards (validated by the ingestion worker); ones already added are skipped. */
export async function importBoards(tx: DbClient, text: string): Promise<ImportResult> {
  const settings = await settingsRow(tx);
  if (!settings?.consentedAt) return { ok: false, status: 409, error: "Give permission for discovery on this page first" };
  const links = extractBoardLinks(text);
  const known = new Set(
    (await tx.select({ kind: jobSources.kind, config: jobSources.config }).from(jobSources))
      .filter((s) => s.config.slug).map((s) => `${s.kind}:${s.config.slug!.toLowerCase()}`),
  );
  const fresh = links.filter((l) => !known.has(`${l.kind}:${l.slug.toLowerCase()}`));
  return { ok: true, recognized: links.length, added: await insertPendingBoards(tx, fresh, null) };
}
