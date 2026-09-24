-- Custom SQL migration: RLS and the index drizzle-kit cannot generate.
-- Follows 0015_resume_optimization_rls_and_indexes.sql.

ALTER TABLE company_research ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON company_research
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE company_research_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON company_research_facts
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE application_pitches ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON application_pitches
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- loadCompanyResearch / refresh's delete-then-insert: every fact for one research row. Postgres does
-- not auto-index a foreign-key column. company_research lookups by company_key and application_pitches
-- lookups by job_id are covered by their unique indexes' leftmost columns (user_id first, then the key).
CREATE INDEX company_research_facts_research_id_idx ON company_research_facts (research_id);
