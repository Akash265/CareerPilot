-- Custom SQL migration: RLS and the partial unique index drizzle-kit cannot generate for Phase 13a. Follows 0032.

ALTER TABLE search_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON search_runs
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- At most one search run in progress per user: a second click returns the existing run instead.
CREATE UNIQUE INDEX search_runs_user_active_uniq ON search_runs (user_id) WHERE status IN ('queued', 'running', 'matching');
