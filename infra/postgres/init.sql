CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Also create a dedicated test database so Task 4's RLS tests never
-- run against dev data.
CREATE DATABASE career_intel_test;
\connect career_intel_test
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
