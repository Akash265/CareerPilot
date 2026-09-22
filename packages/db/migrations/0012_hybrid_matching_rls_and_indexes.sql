-- Custom SQL migration: RLS and the indexes drizzle-kit cannot generate.
-- Follows 0001_users_rls.sql / 0007_career_goal_rls.sql / 0010_job_intelligence_rls_and_indexes.sql.

ALTER TABLE job_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON job_matches
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE matching_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON matching_runs
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- Ranked-list query: a user's eligible matches, best first (Task 10's GET /api/matches).
CREATE INDEX job_matches_user_eligible_score_idx ON job_matches (user_id, eligible, overall_score DESC);
CREATE INDEX matching_runs_user_started_idx ON matching_runs (user_id, started_at DESC);

-- HNSW cosine index for Task 6's semantic-retrieval query. Requires pgvector >= 0.5.0, confirmed
-- above against the running pgvector/pgvector:pg16 image.
CREATE INDEX jobs_embedding_hnsw_idx ON jobs USING hnsw (embedding vector_cosine_ops);
