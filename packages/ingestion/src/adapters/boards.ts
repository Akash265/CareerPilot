import {
  AshbyBoardResponseSchema,
  RecruiteeOffersResponseSchema,
  SmartRecruitersListItemSchema,
  SmartRecruitersListSchema,
  WorkableAccountResponseSchema,
} from "../sourceSchemas";
import { IngestError, type RawRecord, type SourceAdapter, type SourceRef } from "../types";
import { fetchJson } from "./http";
import { assertValidSlug } from "./slug";

/**
 * Phase 12 (D184): the four ATS boards added beside Greenhouse and Lever. Each fetches one company's public job
 * board by `config.slug` (validated so it can never change the host or path) and yields one raw record per job.
 */
interface BoardOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
}

const trimBase = (base: string) => base.replace(/\/+$/, "");
const idOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;

export function createAshbyAdapter(opts: BoardOptions): SourceAdapter {
  return {
    async *fetch(source: SourceRef): AsyncIterable<RawRecord> {
      const slug = assertValidSlug(source.config.slug);
      const url = `${trimBase(opts.baseUrl)}/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
      const envelope = AshbyBoardResponseSchema.safeParse(await fetchJson(url, { fetchFn: opts.fetchFn }));
      if (!envelope.success) throw new IngestError("schema_mismatch");
      for (const job of envelope.data.jobs) {
        const j = job as { id?: unknown; isListed?: unknown } | null;
        const id = idOf(j?.id);
        if (!id || j?.isListed === false) continue; // unlisted jobs are not public openings
        yield { externalId: id, payload: job };
      }
    },
  };
}

export function createWorkableAdapter(opts: BoardOptions): SourceAdapter {
  return {
    async *fetch(source: SourceRef): AsyncIterable<RawRecord> {
      const slug = assertValidSlug(source.config.slug);
      const url = `${trimBase(opts.baseUrl)}/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`;
      const envelope = WorkableAccountResponseSchema.safeParse(await fetchJson(url, { fetchFn: opts.fetchFn }));
      if (!envelope.success) throw new IngestError("schema_mismatch");
      for (const job of envelope.data.jobs) {
        const id = idOf((job as { shortcode?: unknown } | null)?.shortcode);
        if (!id || typeof job !== "object" || job === null) continue;
        // Workable's job objects carry no company name; the account's is copied in so the record stands alone.
        yield { externalId: id, payload: { ...job, account_name: envelope.data.name ?? null } };
      }
    },
  };
}

export function createRecruiteeAdapter(opts: { baseUrlTemplate: string; fetchFn?: typeof fetch }): SourceAdapter {
  return {
    async *fetch(source: SourceRef): AsyncIterable<RawRecord> {
      // The slug becomes part of a host name here, so the same safe-character check is what keeps it on recruitee.com.
      const slug = assertValidSlug(source.config.slug);
      const url = `${trimBase(opts.baseUrlTemplate.replace("{slug}", encodeURIComponent(slug)))}/api/offers/`;
      const envelope = RecruiteeOffersResponseSchema.safeParse(await fetchJson(url, { fetchFn: opts.fetchFn }));
      if (!envelope.success) throw new IngestError("schema_mismatch");
      for (const offer of envelope.data.offers) {
        const id = idOf((offer as { id?: unknown } | null)?.id);
        if (id) yield { externalId: id, payload: offer };
      }
    },
  };
}

const SR_PAGE = 100;
/** Each SmartRecruiters posting needs its own request for the description; at the polite pace one board is capped. */
export const SMARTRECRUITERS_MAX_POSTINGS = 200;

export function createSmartRecruitersAdapter(opts: BoardOptions & { maxPostings?: number }): SourceAdapter {
  const max = opts.maxPostings ?? SMARTRECRUITERS_MAX_POSTINGS;
  return {
    async *fetch(source: SourceRef): AsyncIterable<RawRecord> {
      const slug = encodeURIComponent(assertValidSlug(source.config.slug));
      const base = `${trimBase(opts.baseUrl)}/v1/companies/${slug}/postings`;
      const items: { id: string; releasedDate: string }[] = [];
      for (let offset = 0; ; offset += SR_PAGE) {
        const page = SmartRecruitersListSchema.safeParse(await fetchJson(`${base}?limit=${SR_PAGE}&offset=${offset}`, { fetchFn: opts.fetchFn }));
        if (!page.success) throw new IngestError("schema_mismatch");
        for (const raw of page.data.content) {
          const item = SmartRecruitersListItemSchema.safeParse(raw);
          if (item.success && /^[A-Za-z0-9_-]{1,64}$/.test(item.data.id)) items.push({ id: item.data.id, releasedDate: item.data.releasedDate ?? "" });
        }
        // Listing stops at the cap too: a huge board is read only as far as its newest postings need.
        if (page.data.content.length < SR_PAGE || offset + SR_PAGE >= page.data.totalFound || items.length >= max * 5) break;
      }
      items.sort((a, b) => b.releasedDate.localeCompare(a.releasedDate));
      for (const item of items.slice(0, max)) {
        let detail: unknown;
        try {
          detail = await fetchJson(`${base}/${item.id}`, { fetchFn: opts.fetchFn });
        } catch (error) {
          // One withdrawn posting must not fail the board; a throttled or broken API should (so the run is retried).
          if (error instanceof IngestError && error.errorClass === "not_found") continue;
          throw error;
        }
        yield { externalId: item.id, payload: detail };
      }
    },
  };
}
