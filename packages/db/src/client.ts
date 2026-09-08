import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Env } from "@ai-career/config";
import * as schema from "./schema";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export function createDbClient(env: Pick<Env, "DATABASE_URL">): DbClient {
  const sql = postgres(env.DATABASE_URL);
  return drizzle(sql, { schema });
}

/**
 * `createDbClient` opens a fresh connection pool on every call -- every
 * caller must close it when done, or connections accumulate towards
 * Postgres's `max_connections`. Best-effort: a failure to close must never
 * mask or replace whatever result/error the caller already has. `db.$client`
 * is drizzle-orm's postgres-js escape hatch to the underlying `postgres`
 * client (set at runtime in postgres-js/driver.js's `construct()`, typed on
 * `PostgresJsDatabase`'s return type).
 */
export async function closeDbClient(db: DbClient): Promise<void> {
  try {
    await db.$client?.end();
  } catch {
    // Best-effort cleanup only; must not mask the caller's own result/error.
  }
}

export { schema };
