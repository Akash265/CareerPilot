-- Custom SQL migration: RLS and the indexes drizzle-kit cannot generate for Phase 12 (D184-D186). Follows 0010.

ALTER TABLE discovered_boards ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON discovered_boards
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE discovery_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON discovery_settings
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- A board is recorded once per user, whatever the case of its slug.
CREATE UNIQUE INDEX discovered_boards_user_kind_slug_uniq ON discovered_boards (user_id, kind, lower(slug));

-- One search source per provider: they carry no slug, so job_sources_user_kind_slug_uniq cannot catch it.
CREATE UNIQUE INDEX job_sources_user_search_kind_uniq ON job_sources (user_id, kind) WHERE origin = 'search';
