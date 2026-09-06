import { defineConfig } from "drizzle-kit";
import { loadEnv } from "@ai-career/config";

const env = loadEnv();

// MIGRATIONS_DATABASE_URL is optional in the shared env schema (it must
// never be required in the Next.js app's or workers' environment — see
// DECISIONS.md D12) but is required here: drizzle-kit is the one process
// that legitimately needs the superuser role to run schema DDL.
if (!env.MIGRATIONS_DATABASE_URL) {
  throw new Error(
    "MIGRATIONS_DATABASE_URL is required to run migrations (see .env.example)"
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*.ts",
  out: "./migrations",
  // Migrations run DDL and must use the superuser role — the app-runtime
  // role (env.DATABASE_URL, used by createDbClient) is intentionally
  // least-privilege and cannot create/alter tables. See DECISIONS.md D12.
  dbCredentials: { url: env.MIGRATIONS_DATABASE_URL },
});
