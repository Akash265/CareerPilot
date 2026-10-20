import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { Client } from "minio";

export const GENERATED_DOCUMENTS_BUCKET = "generated-documents";

async function ensureBucketExists(client: Client): Promise<void> {
  const exists = await client.bucketExists(GENERATED_DOCUMENTS_BUCKET).catch(() => false);
  if (!exists) await client.makeBucket(GENERATED_DOCUMENTS_BUCKET);
}

/** Keys are generated here and never contain user-supplied text (Phase 7b design §7). */
export async function uploadGeneratedDocument(
  client: Client,
  params: { userId: string; buffer: Buffer; extension: "pdf" | "docx" | "tex" }
): Promise<{ objectKey: string }> {
  await ensureBucketExists(client);
  const objectKey = `${params.userId}/${randomUUID()}.${params.extension}`;
  await client.putObject(GENERATED_DOCUMENTS_BUCKET, objectKey, params.buffer, params.buffer.length);
  return { objectKey };
}

export async function getGeneratedDocument(client: Client, objectKey: string): Promise<Readable> {
  return client.getObject(GENERATED_DOCUMENTS_BUCKET, objectKey);
}

/** Confirms the object exists without downloading it (a HEAD-style check) -- rejects if it does not, or if
 *  the storage backend cannot be reached. */
export async function statGeneratedDocument(client: Client, objectKey: string): Promise<void> {
  await client.statObject(GENERATED_DOCUMENTS_BUCKET, objectKey);
}

export async function deleteGeneratedDocument(client: Client, objectKey: string): Promise<void> {
  await client.removeObject(GENERATED_DOCUMENTS_BUCKET, objectKey);
}

/** Every object under `prefix` (recursive). An absent bucket has no objects. */
export async function listGeneratedDocuments(client: Client, prefix: string): Promise<{ key: string; lastModified: Date }[]> {
  const exists = await client.bucketExists(GENERATED_DOCUMENTS_BUCKET);
  if (!exists) return [];
  return new Promise((resolve, reject) => {
    const objects: { key: string; lastModified: Date }[] = [];
    const stream = client.listObjectsV2(GENERATED_DOCUMENTS_BUCKET, prefix, true);
    stream.on("data", (item) => {
      if (item.name && item.lastModified) objects.push({ key: item.name, lastModified: item.lastModified });
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(objects));
  });
}
