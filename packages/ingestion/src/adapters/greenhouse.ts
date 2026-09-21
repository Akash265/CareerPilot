import { GreenhouseBoardResponseSchema } from "../sourceSchemas";
import { IngestError, type RawRecord, type SourceAdapter, type SourceRef } from "../types";
import { fetchJson } from "./http";
import { assertValidSlug } from "./slug";

export function createGreenhouseAdapter(opts: { baseUrl: string; fetchFn?: typeof fetch }): SourceAdapter {
  return {
    async *fetch(source: SourceRef): AsyncIterable<RawRecord> {
      const slug = assertValidSlug(source.config.slug);
      const url = `${opts.baseUrl.replace(/\/$/, "")}/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
      const envelope = GreenhouseBoardResponseSchema.safeParse(await fetchJson(url, { fetchFn: opts.fetchFn }));
      if (!envelope.success) throw new IngestError("schema_mismatch");

      for (const job of envelope.data.jobs) {
        const id = (job as { id?: unknown } | null)?.id;
        // A job without an id cannot be tracked across runs, so it is dropped here.
        if (typeof id !== "number" && typeof id !== "string") continue;
        yield { externalId: String(id), payload: job };
      }
    },
  };
}
