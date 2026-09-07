import { randomUUID } from "node:crypto";
import type { Client } from "minio";

export const RESUME_BUCKET = "resumes";

async function ensureBucketExists(client: Client, bucket: string): Promise<void> {
  const exists = await client.bucketExists(bucket).catch(() => false);
  if (!exists) {
    await client.makeBucket(bucket);
  }
}

export async function uploadResume(
  client: Client,
  params: { userId: string; buffer: Buffer; fileExtension: string }
): Promise<{ objectKey: string }> {
  await ensureBucketExists(client, RESUME_BUCKET);
  const objectKey = `${params.userId}/${randomUUID()}.${params.fileExtension}`;
  await client.putObject(RESUME_BUCKET, objectKey, params.buffer, params.buffer.length);
  return { objectKey };
}

export async function deleteResume(client: Client, objectKey: string): Promise<void> {
  await client.removeObject(RESUME_BUCKET, objectKey);
}
