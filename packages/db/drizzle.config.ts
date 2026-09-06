import { defineConfig } from "drizzle-kit";
import { loadEnv } from "@ai-career/config";

const env = loadEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*.ts",
  out: "./migrations",
  // Migrations run DDL and must use the superuser role — the app-runtime
  // role (env.DATABASE_URL, used by createDbClient) is intentionally
  // least-privilege and cannot create/alter tables. See DECISIONS.md D12.
  dbCredentials: { url: env.MIGRATIONS_DATABASE_URL },
});
