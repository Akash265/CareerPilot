-- Custom SQL migration file, put your code below! --

-- Follow-up to 0000_daffy_jigsaw.sql: drizzle-kit does not generate
-- ENABLE ROW LEVEL SECURITY / CREATE POLICY statements, so this is a
-- hand-written migration (per DECISIONS.md D2).
--
-- `users` is the identity table itself, not a user-scoped table in the D2
-- sense (D2's `user_id` column convention is for tables that BELONG TO a
-- user -- e.g. future `jobs`, `resumes`, `applications` -- via a `user_id`
-- column referencing `users.id`). For `users` itself, the self-referencing
-- equivalent is `id = current_setting('app.current_user_id')::uuid`: a
-- session may only see the user row matching its own active user id. The
-- `id` column's default (see packages/db/src/schema/users.ts) is the same
-- expression, so a plain INSERT with no `id` supplied lands on the active
-- session's user rather than a random UUID that this policy would then
-- reject (CREATE POLICY with USING and no WITH CHECK reuses USING for
-- INSERT too).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON users
  USING (id = current_setting('app.current_user_id')::uuid);
