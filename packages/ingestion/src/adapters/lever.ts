import { LeverPostingsResponseSchema } from "../sourceSchemas";
import { IngestError, type RawRecord, type SourceAdapter, type SourceRef } from "../types";
import { fetchJson } from "./http";
import { assertValidSlug } from "./slug";

export function createLeverAdapter(opts: { baseUrl: string; fetchFn?: typeof fetch }): SourceAdapter {
  return {
    async *fetch(source: SourceRef): AsyncIterable<RawRecord> {
      const slug = assertValidSlug(source.config.slug);
      const url = `${opts.baseUrl.replace(/\/$/, "")}/v0/postings/${encodeURIComponent(slug)}?mode=json`;
      const envelope = LeverPostingsResponseSchema.safeParse(await fetchJson(url, { fetchFn: opts.fetchFn }));
      if (!envelope.success) throw new IngestError("schema_mismatch");

      for (const posting of envelope.data) {
        const id = (posting as { id?: unknown } | null)?.id;
        if (typeof id !== "string" || id.length === 0) continue;
        yield { externalId: id, payload: posting };
      }
    },
  };
}
