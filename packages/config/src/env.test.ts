import { describe, it, expect } from "vitest";
import { loadEnv } from "./env";

const validSource = {
  NODE_ENV: "test",
  DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000001",
  DATABASE_URL: "postgres://user:pass@localhost:5432/career_intel",
  REDIS_URL: "redis://localhost:6379",
  MINIO_ENDPOINT: "http://localhost:9000",
  MINIO_ACCESS_KEY: "minioadmin",
  MINIO_SECRET_KEY: "minioadmin",
  ANTHROPIC_API_KEY: "sk-ant-test",
  EMBEDDING_PROVIDER: "voyage",
  VOYAGE_API_KEY: "voyage-test-key",
};

describe("loadEnv", () => {
  it("parses a fully valid environment", () => {
    const env = loadEnv(validSource);
    expect(env.DEFAULT_USER_ID).toBe("00000000-0000-0000-0000-000000000001");
    expect(env.EMBEDDING_PROVIDER).toBe("voyage");
  });

  it("rejects a non-UUID DEFAULT_USER_ID", () => {
    expect(() =>
      loadEnv({ ...validSource, DEFAULT_USER_ID: "not-a-uuid" })
    ).toThrow(/DEFAULT_USER_ID/);
  });

  it("requires VOYAGE_API_KEY when EMBEDDING_PROVIDER is voyage", () => {
    const { VOYAGE_API_KEY, ...rest } = validSource;
    expect(() => loadEnv({ ...rest, EMBEDDING_PROVIDER: "voyage" })).toThrow(
      /VOYAGE_API_KEY/
    );
  });

  it("allows missing VOYAGE_API_KEY when EMBEDDING_PROVIDER is self-hosted", () => {
    const { VOYAGE_API_KEY, ...rest } = validSource;
    const env = loadEnv({ ...rest, EMBEDDING_PROVIDER: "self-hosted" });
    expect(env.EMBEDDING_PROVIDER).toBe("self-hosted");
  });

  it("rejects a missing required field with a readable message", () => {
    const { DATABASE_URL, ...rest } = validSource;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });
});
