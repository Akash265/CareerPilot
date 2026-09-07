import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    DEFAULT_USER_ID: z.string().uuid(),
    DATABASE_URL: z.string().url(),
    // Optional in the shared schema: only `packages/db/drizzle.config.ts`
    // (run standalone by drizzle-kit, never by the Next.js app or workers)
    // needs the superuser DSN. Keeping it optional here means the app/worker
    // processes are never required to hold this credential in their
    // environment at all — see DECISIONS.md D12.
    MIGRATIONS_DATABASE_URL: z.string().url().optional(),
    REDIS_URL: z.string().url(),
    MINIO_ENDPOINT: z.string().url(),
    MINIO_ACCESS_KEY: z.string().min(1),
    MINIO_SECRET_KEY: z.string().min(1),
    ANTHROPIC_API_KEY: z.string().min(1),
    EMBEDDING_PROVIDER: z.enum(["voyage", "self-hosted"]),
    VOYAGE_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_MODEL_FAST: z.string().min(1),
    VOYAGE_EMBEDDING_MODEL: z.string().min(1),
  })
  .superRefine((val, ctx) => {
    if (val.EMBEDDING_PROVIDER === "voyage" && !val.VOYAGE_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VOYAGE_API_KEY"],
        message: "VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env
): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  return result.data;
}
