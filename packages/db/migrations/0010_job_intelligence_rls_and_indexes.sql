-- Custom SQL migration: RLS, pg_trgm and the indexes drizzle-kit cannot generate.
-- Follows 0001_users_rls.sql / 0007_career_goal_rls.sql.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE job_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON job_sources
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE ingestion_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON ingestion_runs
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE raw_job_postings ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON raw_job_postings
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON jobs
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE job_postings ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON job_postings
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE job_duplicate_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON job_duplicate_candidates
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- The same board (kind + slug, case-insensitive) cannot be added twice. Uploads have no slug.
CREATE UNIQUE INDEX job_sources_user_kind_slug_uniq
  ON job_sources (user_id, kind, lower(config->>'slug'))
  WHERE kind <> 'upload';

-- Jobs list text filter (ILIKE) and tier-3 duplicate matching.
CREATE INDEX jobs_title_trgm_idx ON jobs USING gin (title gin_trgm_ops);
CREATE INDEX jobs_company_name_trgm_idx ON jobs USING gin (company_name gin_trgm_ops);
CREATE INDEX jobs_location_key_idx ON jobs (location_key);
CREATE INDEX jobs_status_idx ON jobs (status);

CREATE INDEX job_postings_fingerprint_idx ON job_postings (fingerprint);
CREATE INDEX job_postings_job_id_idx ON job_postings (job_id);
CREATE INDEX ingestion_runs_source_started_idx ON ingestion_runs (source_id, started_at DESC);
