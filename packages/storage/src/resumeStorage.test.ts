import { describe, it, expect, afterAll } from "vitest";
import { createStorageClient } from "./client";
import { uploadResume, deleteResume, RESUME_BUCKET } from "./resumeStorage";

const client = createStorageClient({
  MINIO_ENDPOINT: process.env.TEST_MINIO_ENDPOINT ?? "http://localhost:9000",
  MINIO_ACCESS_KEY: process.env.TEST_MINIO_ACCESS_KEY ?? "minioadmin",
  MINIO_SECRET_KEY: process.env.TEST_MINIO_SECRET_KEY ?? "minioadmin",
});

const uploadedKeys: string[] = [];

afterAll(async () => {
  for (const key of uploadedKeys) {
    await deleteResume(client, key).catch(() => {});
  }
});

describe("uploadResume / deleteResume", () => {
  it("uploads a buffer and makes it retrievable, then deletes it", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    const buffer = Buffer.from("%PDF-1.4 fake resume content");

    const { objectKey } = await uploadResume(client, {
      userId,
      buffer,
      fileExtension: "pdf",
    });
    uploadedKeys.push(objectKey);

    expect(objectKey.startsWith(`${userId}/`)).toBe(true);
    expect(objectKey.endsWith(".pdf")).toBe(true);

    const stat = await client.statObject(RESUME_BUCKET, objectKey);
    expect(stat.size).toBe(buffer.length);

    await deleteResume(client, objectKey);
    await expect(client.statObject(RESUME_BUCKET, objectKey)).rejects.toThrow();
  });
});
