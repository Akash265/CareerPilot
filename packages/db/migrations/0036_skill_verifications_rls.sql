-- Custom SQL migration: RLS drizzle-kit cannot generate for Phase 13b. Follows 0034.

ALTER TABLE skill_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON skill_verifications
  USING (user_id = current_setting('app.current_user_id')::uuid);
