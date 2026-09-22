import { schema, type DbClient } from "@ai-career/db";
import type { RawRecord } from "../types";
import { hashPayload } from "./hashPayload";

const { jobSources, rawJobPostings } = schema;
const INSERT_CHUNK = 500;

/**
 * Persist a parsed upload as a new upload-kind source plus its raw records, ready for the worker.
 * The caller has already confirmed the user's consent for this file (the upload API requires it),
 * so the source is created enabled and consented. Call inside `withUserContext`.
 */
export async function storeUpload(
  tx: DbClient,
  input: { filename: string; records: RawRecord[]; now: Date }
): Promise<{ sourceId: string; count: number }> {
  const [source] = await tx
    .insert(jobSources)
    .values({
      kind: "upload",
      // The filename is attacker-controlled multipart input; strip NUL bytes before it reaches
      // this text column (Postgres rejects them outright), same as every other operator-entered
      // string that lands here.
      label: input.filename.replace(/\u0000/g, "").slice(0, 120),
      config: {},
      enabled: true,
      consentConfirmedAt: input.now,
    })
    .returning({ id: jobSources.id });

  for (let i = 0; i < input.records.length; i += INSERT_CHUNK) {
    await tx.insert(rawJobPostings).values(
      input.records.slice(i, i + INSERT_CHUNK).map((record) => ({
        sourceId: source.id,
        externalId: record.externalId,
        payload: record.payload,
        contentHash: hashPayload(record.payload),
        fetchedAt: input.now,
      }))
    );
  }
  return { sourceId: source.id, count: input.records.length };
}
