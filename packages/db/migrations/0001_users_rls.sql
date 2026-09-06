-- Custom SQL migration file, put your code below! --

-- Follow-up to 0000_fat_speedball.sql: drizzle-kit does not generate
-- ENABLE ROW LEVEL SECURITY / CREATE POLICY statements, so this is a
-- hand-written migration (per DECISIONS.md D2).
--
-- Deviation from the task-4 brief's literal Step 9 SQL: the brief's snippet
-- reads `USING (user_id = current_setting('app.current_user_id')::uuid)`,
-- but the `users` table (packages/db/src/schema/users.ts, Step 2) has no
-- `user_id` column -- it only has `id`, `full_name`, `email`, `created_at`.
-- Running the brief's literal SQL against this table fails:
--   ERROR:  column "user_id" does not exist
-- (confirmed against the live `career_intel` database before writing this
-- file). This is expected: `users` is the identity table itself, not a
-- user-scoped table in the D2 sense (D2's `user_id` column convention is for
-- tables that BELONG TO a user -- e.g. future `jobs`, `resumes`,
-- `applications` tables -- via a `user_id` column referencing `users.id`).
-- For the `users` table itself, the self-referencing equivalent is
-- `id = current_setting('app.current_user_id')::uuid`: a session may only
-- see the user row matching its own active user id. This preserves the same
-- isolation guarantee and the same `withUserContext` mechanism proven in
-- packages/db/src/rls.test.ts, just applied to the one column that actually
-- identifies the row's owner on this table.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON users
  USING (id = current_setting('app.current_user_id')::uuid);
