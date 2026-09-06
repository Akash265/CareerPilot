import { NextResponse } from "next/server";
import { createDbClient } from "@ai-career/db";
import { sql } from "drizzle-orm";
import Redis from "ioredis";
import { loadEnv } from "@ai-career/config";

export async function GET() {
  const env = loadEnv();
  const checks = { database: false, redis: false };

  try {
    const db = createDbClient(env);
    try {
      await db.execute(sql`SELECT 1`);
      checks.database = true;
    } finally {
      // createDbClient opens a fresh postgres connection pool on every call
      // (see packages/db/src/client.ts). This route is polled repeatedly by
      // CI/deploy smoke checks, so the pool must be closed every time or it
      // leaks connections and eventually exhausts Postgres's connection
      // limit on the exact endpoint meant to prove liveness. `db.$client` is
      // drizzle-orm's postgres-js escape hatch to the underlying `postgres`
      // client (set at runtime in postgres-js/driver.js's `construct()`, and
      // typed on `PostgresJsDatabase`'s return type) -- closing it here is
      // best-effort cleanup and must not affect the check result above.
      try {
        await db.$client?.end();
      } catch {
        // Best-effort cleanup only; must not affect the check result above.
      }
    }
  } catch {
    checks.database = false;
  }

  try {
    // lazyConnect defers connecting until the first command (ping), so no
    // explicit `.connect()` call is needed here.
    const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    const pong = await redis.ping();
    checks.redis = pong === "PONG";
    try {
      redis.disconnect();
    } catch {
      // Best-effort cleanup only; must not affect the check result above.
    }
  } catch {
    checks.redis = false;
  }

  const status = checks.database && checks.redis ? "ok" : "degraded";
  return NextResponse.json({ status, checks }, { status: status === "ok" ? 200 : 503 });
}
