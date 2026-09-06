CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Also create a dedicated test database so Task 4's RLS tests never
-- run against dev data.
CREATE DATABASE career_intel_test;
\connect career_intel_test
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Least-privilege application role (DECISIONS.md D12). `career_intel`
-- (POSTGRES_USER) is a Postgres superuser and therefore always bypasses RLS,
-- no matter how policies are configured -- it exists only to run migrations.
-- Real app runtime connections (packages/db's createDbClient) must use this
-- role instead, or RLS enforcement is silently inert.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'career_intel_app') THEN
    CREATE ROLE career_intel_app WITH LOGIN PASSWORD 'career_intel_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE career_intel TO career_intel_app;
\connect career_intel
GRANT USAGE ON SCHEMA public TO career_intel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO career_intel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO career_intel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO career_intel_app;

GRANT CONNECT ON DATABASE career_intel_test TO career_intel_app;
\connect career_intel_test
GRANT USAGE ON SCHEMA public TO career_intel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO career_intel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO career_intel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO career_intel_app;
