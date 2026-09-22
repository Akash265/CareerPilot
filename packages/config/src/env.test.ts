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

  it("defaults the ingestion settings and lets them be overridden", () => {
    const env = loadEnv(validSource);
    expect(env.GREENHOUSE_API_BASE).toBe("https://boards-api.greenhouse.io");
    expect(env.LEVER_API_BASE).toBe("https://api.lever.co");
    expect(env.INGEST_INTERVAL_MINUTES).toBe(360);

    const custom = loadEnv({ ...validSource, GREENHOUSE_API_BASE: "http://localhost:4010", INGEST_INTERVAL_MINUTES: "15" });
    expect(custom.GREENHOUSE_API_BASE).toBe("http://localhost:4010");
    expect(custom.INGEST_INTERVAL_MINUTES).toBe(15);
  });

  it("rejects a too-short ingestion interval and a malformed API base", () => {
    expect(() => loadEnv({ ...validSource, INGEST_INTERVAL_MINUTES: "1" })).toThrow(/INGEST_INTERVAL_MINUTES/);
    expect(() => loadEnv({ ...validSource, LEVER_API_BASE: "not-a-url" })).toThrow(/LEVER_API_BASE/);
  });

  it("defaults the matching settings and lets them be overridden", () => {
    const env = loadEnv(validSource);
    expect(env.MATCHING_EXPLAIN_TOP_N).toBe(25);
    expect(env.MATCHING_EXPERIENCE_GRACE_YEARS).toBe(1);
    expect(env.MATCHING_FRESHNESS_HALF_LIFE_HOURS).toBe(168);
    expect(env.MATCHING_EXPLANATION_TTL_DAYS).toBe(7);

    const custom = loadEnv({ ...validSource, MATCHING_EXPLAIN_TOP_N: "10" });
    expect(custom.MATCHING_EXPLAIN_TOP_N).toBe(10);
  });
});
