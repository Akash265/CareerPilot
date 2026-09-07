import { Client } from "minio";
import type { Env } from "@ai-career/config";

export function createStorageClient(
  env: Pick<Env, "MINIO_ENDPOINT" | "MINIO_ACCESS_KEY" | "MINIO_SECRET_KEY">
): Client {
  const url = new URL(env.MINIO_ENDPOINT);
  return new Client({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    useSSL: url.protocol === "https:",
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
  });
}
