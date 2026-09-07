import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Env } from "@ai-career/config";
import * as schema from "./schema";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export function createDbClient(env: Pick<Env, "DATABASE_URL">): DbClient {
  const sql = postgres(env.DATABASE_URL);
  return drizzle(sql, { schema });
}

export { schema };
