import { eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { createGreenhouseAdapter } from "../adapters/greenhouse";
import { createLeverAdapter } from "../adapters/lever";
import { createAshbyAdapter, createRecruiteeAdapter, createSmartRecruitersAdapter, createWorkableAdapter } from "../adapters/boards";
import { createSearchAdapter, type SearchAdapterOptions } from "../adapters/search";
import { isSearchKind, type RawRecord, type SourceAdapter, type SourceRef } from "../types";

const { rawJobPostings } = schema;

/** An upload's "fetch" is reading back the raw records the upload API stored. */
export function createStoredRawAdapter(db: DbClient, userId: string): SourceAdapter {
  return {
    async *fetch(source: SourceRef): AsyncIterable<RawRecord> {
      const rows = await withUserContext(db, userId, (tx) =>
        tx
          .select({ externalId: rawJobPostings.externalId, payload: rawJobPostings.payload })
          .from(rawJobPostings)
          .where(eq(rawJobPostings.sourceId, source.id))
          .orderBy(rawJobPostings.externalId)
      );
      for (const row of rows) yield { externalId: row.externalId, payload: row.payload };
    },
  };
}

/** Every provider's base URL (and the search keys), from the validated env (D184). */
export interface ProviderConfig {
  boards: { greenhouse: string; lever: string; ashby: string; workable: string; smartrecruiters: string; recruiteeTemplate: string };
  search: Omit<SearchAdapterOptions, "fetchFn">;
}

export interface ProviderEnv {
  GREENHOUSE_API_BASE: string; LEVER_API_BASE: string; ASHBY_API_BASE: string; WORKABLE_API_BASE: string;
  SMARTRECRUITERS_API_BASE: string; RECRUITEE_API_BASE: string; ADZUNA_API_BASE: string; JOOBLE_API_BASE: string;
  USAJOBS_API_BASE: string; THEMUSE_API_BASE: string; REMOTIVE_API_BASE: string; REMOTEOK_API_BASE: string;
  ARBEITNOW_API_BASE: string; HN_API_BASE: string; ADZUNA_APP_ID?: string; ADZUNA_APP_KEY?: string; ADZUNA_COUNTRIES: string[];
  JOOBLE_API_KEY?: string; USAJOBS_API_KEY?: string; USAJOBS_USER_AGENT?: string;
}

export function providerConfigFromEnv(env: ProviderEnv): ProviderConfig {
  return {
    boards: {
      greenhouse: env.GREENHOUSE_API_BASE, lever: env.LEVER_API_BASE, ashby: env.ASHBY_API_BASE, workable: env.WORKABLE_API_BASE,
      smartrecruiters: env.SMARTRECRUITERS_API_BASE, recruiteeTemplate: env.RECRUITEE_API_BASE,
    },
    search: {
      bases: {
        adzuna: env.ADZUNA_API_BASE, jooble: env.JOOBLE_API_BASE, usajobs: env.USAJOBS_API_BASE, themuse: env.THEMUSE_API_BASE,
        remotive: env.REMOTIVE_API_BASE, remoteok: env.REMOTEOK_API_BASE, arbeitnow: env.ARBEITNOW_API_BASE, hn_hiring: env.HN_API_BASE,
      },
      keys: {
        adzunaAppId: env.ADZUNA_APP_ID, adzunaAppKey: env.ADZUNA_APP_KEY, adzunaCountries: env.ADZUNA_COUNTRIES,
        joobleKey: env.JOOBLE_API_KEY, usajobsKey: env.USAJOBS_API_KEY, usajobsUserAgent: env.USAJOBS_USER_AGENT,
      },
    },
  };
}

export interface AdapterForOptions {
  db: DbClient;
  userId: string;
  providers: ProviderConfig;
  /** The worker passes a polite fetch (createPoliteFetch) shared by every adapter. */
  fetchFn?: typeof fetch;
}

export function createAdapterFor(opts: AdapterForOptions): (source: SourceRef) => SourceAdapter {
  const { boards, search } = opts.providers;
  const fetchFn = opts.fetchFn;
  return (source) => {
    if (isSearchKind(source.kind)) return createSearchAdapter(source.kind, { ...search, fetchFn });
    switch (source.kind) {
      case "greenhouse":
        return createGreenhouseAdapter({ baseUrl: boards.greenhouse, fetchFn });
      case "lever":
        return createLeverAdapter({ baseUrl: boards.lever, fetchFn });
      case "ashby":
        return createAshbyAdapter({ baseUrl: boards.ashby, fetchFn });
      case "workable":
        return createWorkableAdapter({ baseUrl: boards.workable, fetchFn });
      case "smartrecruiters":
        return createSmartRecruitersAdapter({ baseUrl: boards.smartrecruiters, fetchFn });
      case "recruitee":
        return createRecruiteeAdapter({ baseUrlTemplate: boards.recruiteeTemplate, fetchFn });
      case "upload":
        return createStoredRawAdapter(opts.db, opts.userId);
    }
  };
}
