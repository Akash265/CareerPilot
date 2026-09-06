import { sql } from "drizzle-orm";
import type { DbClient } from "./client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every query touching a user-scoped table must go through this helper.
 * It sets the RLS session variable inside a transaction so it can never
 * leak across concurrent requests on a pooled connection.
 */
export async function withUserContext<T>(
  db: DbClient,
  userId: string,
  fn: (tx: DbClient) => Promise<T>
): Promise<T> {
  if (!UUID_RE.test(userId)) {
    throw new Error(`withUserContext: user id must be a UUID, got "${userId}"`);
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_user_id', ${userId}, true)`
    );
    return fn(tx as unknown as DbClient);
  });
}
