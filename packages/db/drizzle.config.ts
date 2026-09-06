import { defineConfig } from "drizzle-kit";
import { loadEnv } from "@ai-career/config";

const env = loadEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*.ts",
  out: "./migrations",
  dbCredentials: { url: env.DATABASE_URL },
});
