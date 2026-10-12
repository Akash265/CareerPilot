import {
  AdzunaResponseSchema,
  ArbeitnowResponseSchema,
  HnItemSchema,
  HnSearchResponseSchema,
  JoobleResponseSchema,
  MuseResponseSchema,
  RemoteOkResponseSchema,
  RemotiveResponseSchema,
  UsaJobsResponseSchema,
} from "../sourceSchemas";
import { htmlToText } from "../normalize/text";
import { IngestError, type RawRecord, type SearchKind, type SearchQuery, type SourceAdapter, type SourceRef } from "../types";
import { fetchJson, type FetchJsonOptions } from "./http";

/**
 * Phase 12 (D187): goal-driven search providers. A search source stores no query; the pipeline puts the active
 * confirmed career goal's roles and locations on `SourceRef.query`, and each adapter turns that into requests.
 * Every run is capped at MAX_SEARCH_REQUESTS requests, however many roles x locations x pages the goal implies.
 */
export const MAX_SEARCH_REQUESTS = 50;

export interface SearchAdapterOptions {
  bases: Record<SearchKind, string>;
  keys: {
    adzunaAppId?: string;
    adzunaAppKey?: string;
    adzunaCountries: string[];
    joobleKey?: string;
    usajobsKey?: string;
    usajobsUserAgent?: string;
  };
  fetchFn?: typeof fetch;
}

/** `?a=b&c=d` with spaces as %20 (URLSearchParams would write "+"), repeated keys allowed. */
const qs = (params: [string, string | number][]) =>
  params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
const trimBase = (base: string) => base.replace(/\/+$/, "");

/** Counts requests across one run and refuses the one past the budget. */
function budgeted(opts: SearchAdapterOptions) {
  let used = 0;
  return {
    get exhausted() {
      return used >= MAX_SEARCH_REQUESTS;
    },
    async get(url: string, extra: Omit<FetchJsonOptions, "fetchFn"> = {}): Promise<unknown> {
      used++;
      return fetchJson(url, { ...extra, fetchFn: opts.fetchFn });
    },
  };
}

function queryOf(source: SourceRef): SearchQuery {
  if (!source.query) throw new IngestError("no_active_goal");
  if (source.query.roles.length === 0) throw new IngestError("no_search_terms");
  return source.query;
}

/** A goal with no locations still searches once per role; "" means "anywhere" to every provider. */
const locationsOf = (q: SearchQuery) => (q.locations.length > 0 ? q.locations : [""]);

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new IngestError("schema_mismatch");
  return result.data;
}

const idOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;

// --- The Muse: no keyword search and no date order, so roles map to its categories and titles are filtered ---

const MUSE_CATEGORIES: [RegExp, string][] = [
  [/\bdata\b|analytic|analyst|machine learning|\bml\b|\bai\b|scientist/i, "Data and Analytics"],
  [/engineer|developer|software|devops|\bsre\b|backend|frontend|full.?stack|programmer|architect/i, "Software Engineering"],
  [/product (manager|owner|lead)/i, "Product Management"],
  [/design|\bux\b|\bui\b/i, "Design and UX"],
  [/sales|account executive|business development/i, "Sales"],
  [/project manager|program manager|scrum/i, "Project Management"],
  [/customer|support|success/i, "Customer Service"],
  [/operations|strategy/i, "Business Operations"],
];

export function museCategoriesFor(roles: string[]): string[] {
  return MUSE_CATEGORIES.filter(([re]) => roles.some((r) => re.test(r))).map(([, name]) => name);
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9+#]+/g) ?? [];
/** True when every word of some role appears in the title ("Data Engineer" matches "Senior Data Engineer"). */
export function titleMatchesRole(title: string, roles: string[]): boolean {
  const titleWords = new Set(words(title));
  return roles.some((role) => {
    const roleWords = words(role);
    return roleWords.length > 0 && roleWords.every((w) => titleWords.has(w));
  });
}

// --- HN "Who is hiring?": one comment per company, first line "Company (Where) | Role | ..." ---

const ROLE_WORDS = /engineer|developer|scientist|manager|designer|analyst|lead\b|architect|director|head of|\bswe\b|\bsre\b|devops|product|researcher|intern|specialist|consultant|recruiter|officer|administrator|marketing|sales|founding/i;
const PLACE_WORDS = /remote|onsite|on-site|hybrid|,\s*[A-Z]{2}\b|\b(US|USA|UK|EU|Europe|NYC|SF)\b|london|berlin|new york|san francisco|toronto|paris|amsterdam/i;

export interface HnFirstLine {
  company: string;
  title: string;
  location: string | null;
  workMode: "remote" | "hybrid" | "onsite" | null;
}

export function parseHnFirstLine(line: string): HnFirstLine {
  const segments = line.split(/\s+[|—–]\s+/).map((s) => s.trim()).filter(Boolean);
  const head = segments[0] ?? "";
  const paren = head.match(/\(([^)]*)\)/)?.[1]?.trim() ?? null;
  const company = head.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const rest = segments.slice(1);
  const title = rest.find((s) => ROLE_WORDS.test(s) && !/^\$|^\d/.test(s)) ?? "Multiple roles";
  const place = rest.find((s) => s !== title && /,/.test(s) && PLACE_WORDS.test(s))
    ?? rest.find((s) => s !== title && PLACE_WORDS.test(s) && !/^(remote|onsite|on-site|hybrid)$/i.test(s))
    ?? (paren && PLACE_WORDS.test(paren) ? paren : null);
  const all = segments.join(" ");
  const workMode = /\bremote\b/i.test(all) ? "remote" : /\bhybrid\b/i.test(all) ? "hybrid" : /\bon-?site\b/i.test(all) ? "onsite" : null;
  return { company, title, location: place, workMode };
}

/** The first line of a comment's HTML, as text. */
export const hnFirstLine = (html: string) => htmlToText(html.split(/<p>/i)[0] ?? "").split("\n")[0].trim();

// --- Adapters ---

type Fetcher = (q: SearchQuery, source: SourceRef, b: ReturnType<typeof budgeted>, opts: SearchAdapterOptions) => AsyncIterable<RawRecord>;

const FETCHERS: Record<SearchKind, Fetcher> = {
  async *remotive(q, _s, b, opts) {
    for (const role of q.roles) {
      if (b.exhausted) return;
      const body = parse(RemotiveResponseSchema, await b.get(`${trimBase(opts.bases.remotive)}/api/remote-jobs?${qs([["search", role], ["limit", 100]])}`));
      for (const job of body.jobs) {
        const id = idOf((job as { id?: unknown } | null)?.id);
        if (id) yield { externalId: id, payload: job };
      }
    }
  },

  async *remoteok(_q, _s, b, opts) {
    const body = parse(RemoteOkResponseSchema, await b.get(`${trimBase(opts.bases.remoteok)}/api`));
    for (const job of body) {
      const id = idOf((job as { id?: unknown } | null)?.id); // the first element is the legal notice, with no id
      if (id) yield { externalId: id, payload: job };
    }
  },

  async *arbeitnow(q, _s, b, opts) {
    for (let page = 1; page <= q.maxPages && !b.exhausted; page++) {
      const body = parse(ArbeitnowResponseSchema, await b.get(`${trimBase(opts.bases.arbeitnow)}/api/job-board-api?page=${page}`));
      if (body.data.length === 0) return;
      for (const job of body.data) {
        const id = idOf((job as { slug?: unknown } | null)?.slug);
        if (id) yield { externalId: id, payload: job };
      }
    }
  },

  async *themuse(q, _s, b, opts) {
    const categories = museCategoriesFor(q.roles);
    if (categories.length === 0) return;
    const params: [string, string][] = categories.map((c) => ["category", c]);
    if (q.remoteOnly) params.push(["location", "Flexible / Remote"]);
    for (let page = 0; page < q.maxPages * 5 && !b.exhausted; page++) {
      const body = parse(MuseResponseSchema, await b.get(`${trimBase(opts.bases.themuse)}/api/public/jobs?${qs([["page", page], ...params])}`));
      if (body.results.length === 0) return;
      for (const job of body.results) {
        const j = job as { id?: unknown; name?: unknown } | null;
        const id = idOf(j?.id);
        if (id && typeof j?.name === "string" && titleMatchesRole(j.name, q.roles)) yield { externalId: id, payload: job };
      }
    }
  },

  async *hn_hiring(_q, _s, b, opts) {
    const base = trimBase(opts.bases.hn_hiring);
    const search = parse(HnSearchResponseSchema, await b.get(`${base}/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10`));
    const thread = search.hits.find((h) => /^Ask HN: Who is hiring\?/i.test(h.title ?? ""));
    if (!thread || !/^\d{1,12}$/.test(thread.objectID)) return;
    const item = parse(HnItemSchema, await b.get(`${base}/api/v1/items/${thread.objectID}`));
    for (const child of item.children) {
      const c = child as { id?: unknown; text?: unknown; created_at?: unknown } | null;
      const id = idOf(c?.id);
      if (!id || typeof c?.text !== "string" || c.text.length === 0) continue; // deleted / dead comments carry no text
      yield { externalId: id, payload: { id: c.id, text: c.text, created_at: c.created_at ?? null, thread_id: item.id } };
    }
  },

  async *adzuna(q, _s, b, opts) {
    const { adzunaAppId: appId, adzunaAppKey: appKey, adzunaCountries } = opts.keys;
    if (!appId || !appKey) throw new IngestError("missing_api_key");
    for (const country of adzunaCountries) {
      for (const role of q.roles) {
        for (const where of locationsOf(q)) {
          for (let page = 1; page <= q.maxPages; page++) {
            if (b.exhausted) return;
            const params: [string, string | number][] = [["app_id", appId], ["app_key", appKey], ["what", role]];
            if (where) params.push(["where", where]);
            params.push(["max_days_old", q.maxDaysOld], ["results_per_page", 50], ["content-type", "application/json"]);
            const body = parse(AdzunaResponseSchema, await b.get(`${trimBase(opts.bases.adzuna)}/v1/api/jobs/${country}/search/${page}?${qs(params)}`));
            for (const job of body.results) {
              const id = idOf((job as { id?: unknown } | null)?.id);
              if (id && typeof job === "object" && job !== null) yield { externalId: id, payload: { ...job, search_country: country } };
            }
            if (body.results.length < 50) break;
          }
        }
      }
    }
  },

  async *jooble(q, _s, b, opts) {
    const key = opts.keys.joobleKey;
    if (!key) throw new IngestError("missing_api_key");
    for (const role of q.roles) {
      for (const where of locationsOf(q)) {
        for (let page = 1; page <= q.maxPages; page++) {
          if (b.exhausted) return;
          const body = parse(JoobleResponseSchema, await b.get(`${trimBase(opts.bases.jooble)}/api/${encodeURIComponent(key)}`, {
            method: "POST", body: { keywords: role, location: where, page: String(page) },
          }));
          for (const job of body.jobs) {
            const j = job as { id?: unknown; link?: unknown } | null;
            // Jooble's numeric ids exceed 2^53, so JSON.parse rounds them; the link carries the exact digits.
            const fromLink = typeof j?.link === "string" ? j.link.match(/\/desc\/(-?\d{1,25})(?:[/?#]|$)/)?.[1] : undefined;
            const id = fromLink ?? idOf(j?.id);
            if (id) yield { externalId: id, payload: job };
          }
          if (body.jobs.length === 0) break;
        }
      }
    }
  },

  async *usajobs(q, _s, b, opts) {
    const { usajobsKey: key, usajobsUserAgent: userAgent } = opts.keys;
    if (!key || !userAgent) throw new IngestError("missing_api_key");
    for (const role of q.roles) {
      for (const where of locationsOf(q)) {
        for (let page = 1; page <= q.maxPages; page++) {
          if (b.exhausted) return;
          const params: [string, string | number][] = [["Keyword", role]];
          if (where) params.push(["LocationName", where]);
          params.push(["DatePosted", Math.min(q.maxDaysOld, 60)], ["ResultsPerPage", 100], ["Page", page]);
          const body = parse(UsaJobsResponseSchema, await b.get(`${trimBase(opts.bases.usajobs)}/api/Search?${qs(params)}`, {
            headers: { "authorization-key": key, "user-agent": userAgent },
          }));
          const items = body.SearchResult.SearchResultItems;
          for (const item of items) {
            const id = idOf((item as { MatchedObjectId?: unknown } | null)?.MatchedObjectId);
            if (id) yield { externalId: id, payload: item };
          }
          if (items.length < 100) break;
        }
      }
    }
  },
};

/** Overlapping queries (two roles, two locations) return the same job; a run handles each one once. */
async function* unique(records: AsyncIterable<RawRecord>): AsyncIterable<RawRecord> {
  const seen = new Set<string>();
  for await (const record of records) {
    if (seen.has(record.externalId)) continue;
    seen.add(record.externalId);
    yield record;
  }
}

export function createSearchAdapter(kind: SearchKind, opts: SearchAdapterOptions): SourceAdapter {
  return {
    fetch(source: SourceRef): AsyncIterable<RawRecord> {
      const query = queryOf(source); // throws before any request
      return unique(FETCHERS[kind](query, source, budgeted(opts), opts));
    },
  };
}
