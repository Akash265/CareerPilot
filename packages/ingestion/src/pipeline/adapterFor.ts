import { eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { createGreenhouseAdapter } from "../adapters/greenhouse";
import { createLeverAdapter } from "../adapters/lever";
import type { RawRecord, SourceAdapter, SourceRef } from "../types";

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

export interface AdapterForOptions {
  db: DbClient;
  userId: string;
  greenhouseBaseUrl: string;
  leverBaseUrl: string;
  fetchFn?: typeof fetch;
}

export function createAdapterFor(opts: AdapterForOptions): (source: SourceRef) => SourceAdapter {
  return (source) => {
    switch (source.kind) {
      case "greenhouse":
        return createGreenhouseAdapter({ baseUrl: opts.greenhouseBaseUrl, fetchFn: opts.fetchFn });
      case "lever":
        return createLeverAdapter({ baseUrl: opts.leverBaseUrl, fetchFn: opts.fetchFn });
      case "upload":
        return createStoredRawAdapter(opts.db, opts.userId);
    }
  };
}
