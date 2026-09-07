-- Custom SQL migration file, put your code below! --

-- Follow-up to 0002_wooden_chimera.sql — see 0001_users_rls.sql for why
-- these statements are hand-written (drizzle-kit does not generate RLS).
ALTER TABLE candidate_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON candidate_profiles
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE resume_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON resume_documents
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE education ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON education
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE work_experiences ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON work_experiences
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE work_experience_bullets ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON work_experience_bullets
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON skills
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON projects
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE certifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON certifications
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE achievements ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON achievements
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE company_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON company_preferences
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE profile_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON profile_facts
  USING (user_id = current_setting('app.current_user_id')::uuid);
