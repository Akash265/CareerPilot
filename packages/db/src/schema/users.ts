import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  // `users` is the identity table itself (DECISIONS.md D2/D12), so it uses
  // the same self-referencing RLS pattern other tables apply to their
  // `user_id` column, applied here to `id`: a plain INSERT with no `id`
  // supplied lands on the active session's user rather than a random UUID.
  // (A random default would be rejected by the `user_isolation` policy's
  // USING clause, since CREATE POLICY with no WITH CHECK reuses USING for
  // inserts too.)
  id: uuid("id")
    .primaryKey()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
