-- Custom SQL migration file, put your code below! --

-- Follow-up to 0006_free_franklin_richards.sql -- see 0001_users_rls.sql for why
-- these statements are hand-written (drizzle-kit does not generate RLS).
ALTER TABLE career_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON career_goals
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE career_goal_constraints ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON career_goal_constraints
  USING (user_id = current_setting('app.current_user_id')::uuid);
