import { describe, it, expect } from "vitest";
import { loadEnv } from "./env";

const validSource = {
  NODE_ENV: "test",
  DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000001",
  DATABASE_URL: "postgres://user:pass@localhost:5432/career_intel",
  MIGRATIONS_DATABASE_URL: "postgres://career_intel:career_intel@localhost:5432/career_intel",
  REDIS_URL: "redis://localhost:6379",
  MINIO_ENDPOINT: "http://localhost:9000",
  MINIO_ACCESS_KEY: "minioadmin",
  MINIO_SECRET_KEY: "minioadmin",
  ANTHROPIC_API_KEY: "sk-ant-test",
  EMBEDDING_PROVIDER: "voyage",
  VOYAGE_API_KEY: "voyage-test-key",
  ANTHROPIC_MODEL_FAST: "claude-haiku-4-5-20251001",
  VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
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

  it("allows a missing MIGRATIONS_DATABASE_URL (only drizzle.config.ts requires it narrowly)", () => {
    const { MIGRATIONS_DATABASE_URL, ...rest } = validSource;
    const env = loadEnv(rest);
    expect(env.MIGRATIONS_DATABASE_URL).toBeUndefined();
  });

  it("rejects a malformed MIGRATIONS_DATABASE_URL when one is present", () => {
    expect(() =>
      loadEnv({ ...validSource, MIGRATIONS_DATABASE_URL: "not-a-url" })
    ).toThrow(/MIGRATIONS_DATABASE_URL/);
  });

  it("rejects a missing ANTHROPIC_MODEL_FAST", () => {
    const { ANTHROPIC_MODEL_FAST, ...rest } = validSource;
    expect(() => loadEnv(rest)).toThrow(/ANTHROPIC_MODEL_FAST/);
  });

  it("rejects a missing VOYAGE_EMBEDDING_MODEL", () => {
    const { VOYAGE_EMBEDDING_MODEL, ...rest } = validSource;
    expect(() => loadEnv(rest)).toThrow(/VOYAGE_EMBEDDING_MODEL/);
  });
});
