import { sql } from "drizzle-orm";
import type { DbClient } from "@ai-career/db";

/**
 * Serializes every transaction that allocates a goal version or changes which
 * goal is active for one user (transaction-scoped: released at commit/rollback).
 * Nothing in the schema enforces "sequential version" or "exactly one active
 * goal" (D23/D24), so without this two simultaneous requests read the same
 * max(version) and share a version, or both deactivate-then-activate and leave
 * two active goals. The two-int form namespaces the key so it cannot collide
 * with any other advisory lock keyed on the same user id.
 */
export async function lockUserCareerGoals(tx: DbClient, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('career_goals'), hashtext(${userId}))`);
}
