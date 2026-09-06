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
    await db.execute(sql`SELECT 1`);
    checks.database = true;
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
