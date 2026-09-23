-- Custom SQL migration: RLS and the indexes drizzle-kit cannot generate.
-- Follows 0007_career_goal_rls.sql / 0012_hybrid_matching_rls_and_indexes.sql.

ALTER TABLE job_requirements ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON job_requirements
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE resume_optimizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON resume_optimizations
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE ats_evaluations ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON ats_evaluations
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- ensureJobRequirements' cache lookup (Task 3): every requirement row for a job. Postgres does not
-- auto-index a foreign-key column.
CREATE INDEX job_requirements_job_id_idx ON job_requirements (job_id);

-- listOptimizations' per-job history query (Task 12's GET /api/resume-optimizations/[jobId]) is
-- already covered by resume_optimizations_user_job_version_uniq (user_id, job_id, version) as a
-- leftmost-column lookup, so no separate index is added here.

-- runResumeOptimization's 1:1 join from an optimization to its evaluation (Task 11).
CREATE INDEX ats_evaluations_resume_optimization_id_idx ON ats_evaluations (resume_optimization_id);
