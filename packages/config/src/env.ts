import { z } from "zod";

/** An empty or whitespace-only value (e.g. `AI_MONTHLY_BUDGET_USD=` in .env) counts as unset, so it gets the default. */
const blankAsUnset = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

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
    // Phase 7a company research. A separate role/tier (D7): research uses the basic
    // `web_search_20250305` tool (D79 -- the newer 20260209 tool's dynamic filtering strips
    // citations, producing 0 facts). A separate tier is kept for research quality, not because
    // the fast-tier Haiku model can't run this tool -- it can.
    ANTHROPIC_MODEL_RESEARCH: z.string().min(1),
    VOYAGE_EMBEDDING_MODEL: z.string().min(1),
    // Phase 4 ingestion. The API bases are operator-controlled (never user
    // input), which is what keeps the adapters SSRF-safe; overriding them is how
    // the E2E fake ATS server is used. See DECISIONS.md D3.
    GREENHOUSE_API_BASE: z.string().url().default("https://boards-api.greenhouse.io"),
    LEVER_API_BASE: z.string().url().default("https://api.lever.co"),
    // Phase 11d (D183): overrides Voyage's API base (the default lives in packages/ai's embeddings.ts, the one place
    // that talks to Voyage) so the E2E suite never calls the real API.
    VOYAGE_API_BASE: z.preprocess(blankAsUnset, z.string().url().optional()),
    INGEST_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(360),
    // Phase 5 matching. All tunable, none yet backed by labeled data (design doc §10).
    MATCHING_EXPLAIN_TOP_N: z.coerce.number().int().min(1).max(200).default(25),
    MATCHING_EXPERIENCE_GRACE_YEARS: z.coerce.number().min(0).max(10).default(1),
    MATCHING_FRESHNESS_HALF_LIFE_HOURS: z.coerce.number().min(1).default(168),
    MATCHING_EXPLANATION_TTL_DAYS: z.coerce.number().min(1).default(7),
    // Phase 13b: top eligible matches whose requirements are extracted after each matching run and listed on /skills.
    SKILL_GAP_TOP_N: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(200).default(25)),
    // Phase 7a: web searches allowed per company-research call (the tool's max_uses). Bounds cost.
    COMPANY_RESEARCH_MAX_SEARCHES: z.coerce.number().int().min(1).max(20).default(5),
    // Phase 9: days after an application reaches a terminal status before its job's generated documents
    // are deleted (architecture §9). 0 disables the retention sweep entirely.
    RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
    // Phase 10a insights. An open application with no activity for this many days counts as "no response" /
    // "no interview" (spec §4.2); a later response flips it back, since labels are computed on read.
    OUTCOME_UNDECIDED_DAYS: z.coerce.number().int().min(1).default(30),
    // Phase 10a insights. Fewer decided applications than this in a bucket shows counts only, never a rate.
    INSIGHTS_MIN_BUCKET: z.coerce.number().int().min(2).default(5),
    // Phase 10b personal response model gate (spec §4.3): decided applications with eligible-match factor scores
    // needed before the model is evaluated at all, and the minimum of each class (responses / non-responses).
    OUTCOME_MODEL_MIN_DECIDED: z.coerce.number().int().min(10).default(30),
    OUTCOME_MODEL_MIN_PER_CLASS: z.coerce.number().int().min(3).default(8),
    // Phase 8 browser automation (services/browser-worker only). Chrome is found via Playwright's
    // channel "chrome" unless an explicit executable path is given. Headless is for tests: the whole
    // point of a session is a visible window the user finishes and submits.
    BROWSER_EXECUTABLE_PATH: z.string().min(1).optional(),
    BROWSER_HEADLESS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    BROWSER_SESSION_TIMEOUT_MIN: z.coerce.number().int().min(1).max(240).default(30),
    // Phase 11a AI cost control (design §5). Monthly ceiling on ESTIMATED AI spend in USD; 0 = no ceiling.
    // Blank must fall back to the default: z.coerce.number("") is 0, which would silently mean "unlimited".
    AI_MONTHLY_BUDGET_USD: z.preprocess(blankAsUnset, z.coerce.number().finite().min(0).default(20)),
    AI_BUDGET_WARN_PERCENT: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(100).default(80)),
    // Phase 11a optional Langfuse export (design §6): metadata only. All three or none (checked below).
    LANGFUSE_HOST: z.preprocess(blankAsUnset, z.string().url().regex(/^https?:\/\//i, "must be an http(s) URL").optional()),
    LANGFUSE_PUBLIC_KEY: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    LANGFUSE_SECRET_KEY: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    // Phase 13c: the LaTeX compiler sidecar (services/latex-compiler). Unset → tailored PDF export answers 503.
    LATEX_COMPILER_URL: z.preprocess(blankAsUnset, z.string().url().regex(/^https?:\/\//i, "must be an http(s) URL").optional()),
    LATEX_COMPILER_TOKEN: z.preprocess(blankAsUnset, z.string().min(32, "must be at least 32 characters").optional()),
    RESUME_PAPER_SIZE: z.preprocess(blankAsUnset, z.enum(["a4", "letter"]).default("a4")),
    // Phase 11b (design §3, §5.2). Minimum level the structured logger writes, and how long a worker may go without
    // a heartbeat (they beat every 30 s) before /status calls it "stale".
    LOG_LEVEL: z.preprocess(blankAsUnset, z.enum(["debug", "info", "warn", "error"]).default("info")),
    STATUS_STALE_AFTER_MS: z.preprocess(blankAsUnset, z.coerce.number().int().min(1000).default(90_000)),
    // How often each worker writes its heartbeat. STATUS_STALE_AFTER_MS must be longer (checked below), or a running
    // worker would read as "stale" between two beats; keep both the same for the web app and the workers.
    HEARTBEAT_INTERVAL_MS: z.preprocess(blankAsUnset, z.coerce.number().int().min(1000).default(30_000)),
    // Phase 11c (D177). The interface the web app listens on (read by apps/web's start/dev scripts); 127.0.0.1 keeps
    // it off the network. Extra Host header values the request gate accepts besides localhost (comma-separated).
    APP_HOST: z.preprocess(blankAsUnset, z.string().min(1).default("127.0.0.1")),
    ALLOWED_HOSTS: z.preprocess(
      blankAsUnset,
      z.string().default("").transform((v) => v.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)),
    ),
    // When set, every page and API route needs this token (cookie from /unlock, or a Bearer header).
    APP_ACCESS_TOKEN: z.preprocess(blankAsUnset, z.string().min(32, "must be at least 32 characters").optional()),
    // Phase 11c (D178). Requests per minute for routes that call the AI / start background work; 0 = no limit.
    RATE_LIMIT_AI_PER_MINUTE: z.preprocess(blankAsUnset, z.coerce.number().int().min(0).default(10)),
    RATE_LIMIT_JOBS_PER_MINUTE: z.preprocess(blankAsUnset, z.coerce.number().int().min(0).default(20)),
    // Phase 12 (D184). Provider API bases: operator-controlled like GREENHOUSE_API_BASE (never user input, which keeps the
    // adapters SSRF-safe); tests and E2E point them at local stand-ins. Recruitee is per-company, so its base is a
    // template with a {slug} placeholder.
    ASHBY_API_BASE: z.preprocess(blankAsUnset, z.string().url().default("https://api.ashbyhq.com")),
    WORKABLE_API_BASE: z.preprocess(blankAsUnset, z.string().url().default("https://apply.workable.com")),
    SMARTRECRUITERS_API_BASE: z.preprocess(blankAsUnset, z.string().url().default("https://api.smartrecruiters.com")),
    RECRUITEE_API_BASE: z.preprocess(
      blankAsUnset,
      z.string().regex(/^https?:\/\/\S*\{slug\}\S*$/, "must be an http(s) URL template containing {slug}").default("https://{slug}.recruitee.com"),
    ),
    ADZUNA_API_BASE: z.preprocess(blankAsUnset, z.string().url().default("https://api.adzuna.com")),
    JOOBLE_API_BASE: z.preprocess(blankAsUnset, z.string().url().default("https://jooble.org")),
    USAJOBS_API_BASE: z.preprocess(blankAsUnset, z.string().url().default("https://data.usajobs.gov")),
    THEMUSE_API_BASE: z.preprocess(blankAsUnset, z.string().url().default("https://www.themuse.com")),
    REMOTIVE_API_BASE: z.preprocess(blankAsUnset, z.string().url().default("https://remotive.com")),
    REMOTEOK_API_BASE: z.preprocess(blankAsUnset, z.string().url().default("https://remoteok.com")),
    ARBEITNOW_API_BASE: z.preprocess(blankAsUnset, z.string().url().default("https://www.arbeitnow.com")),
    HN_API_BASE: z.preprocess(blankAsUnset, z.string().url().default("https://hn.algolia.com")),
    // Keys for the search providers that need one; a provider without its key cannot be enabled.
    ADZUNA_APP_ID: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    ADZUNA_APP_KEY: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    ADZUNA_COUNTRIES: z.preprocess(
      blankAsUnset,
      z.string().default("us,gb")
        .transform((v) => v.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean))
        .refine((list) => list.length > 0 && list.every((c) => /^[a-z]{2}$/.test(c)), "must be two-letter country codes, comma-separated"),
    ),
    JOOBLE_API_KEY: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    USAJOBS_API_KEY: z.preprocess(blankAsUnset, z.string().min(1).optional()),
    /** USAJobs requires the registered email as the User-Agent. */
    USAJOBS_USER_AGENT: z.preprocess(blankAsUnset, z.string().email().optional()),
    // Discovery limits (D186, D187).
    DISCOVERY_MAX_DAYS_OLD: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(90).default(30)),
    DISCOVERY_MAX_PAGES: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(10).default(2)),
    DISCOVERY_MAX_SOURCES: z.preprocess(blankAsUnset, z.coerce.number().int().min(0).default(300)),
    DISCOVERY_MAX_NEW_PER_RUN: z.preprocess(blankAsUnset, z.coerce.number().int().min(0).default(25)),
    DISCOVERY_MIN_INTERVAL_MS: z.preprocess(blankAsUnset, z.coerce.number().int().min(0).default(1000)),
    DISCOVERY_STALE_DAYS: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).default(14)),
    // Phase 13a: one-click discovery ("Find matching jobs") and goal seeding.
    FIND_JOBS_FRESH_MINUTES: z.preprocess(blankAsUnset, z.coerce.number().int().min(0).default(360)),
    FIND_JOBS_MAX_WAIT_SECONDS: z.preprocess(blankAsUnset, z.coerce.number().int().min(10).max(3600).default(180)),
    FIND_JOBS_MATCH_WAIT_SECONDS: z.preprocess(blankAsUnset, z.coerce.number().int().min(10).max(3600).default(300)),
    MATCH_DEBOUNCE_SECONDS: z.preprocess(blankAsUnset, z.coerce.number().int().min(0).max(3600).default(120)),
    DISCOVERY_PROBE_MAX_NAMES: z.preprocess(blankAsUnset, z.coerce.number().int().min(0).max(200).default(30)),
    DISCOVERY_WEB_SEARCH: z.preprocess(blankAsUnset, z.enum(["true", "false"]).default("true").transform((v) => v === "true")),
    DISCOVERY_WEB_SEARCH_INTERVAL_DAYS: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(90).default(7)),
    DISCOVERY_WEB_SEARCH_MAX_USES: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(20).default(5)),
  })
  .superRefine((val, ctx) => {
    if (val.EMBEDDING_PROVIDER === "voyage" && !val.VOYAGE_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VOYAGE_API_KEY"],
        message: "VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage",
      });
    }
    if (val.STATUS_STALE_AFTER_MS <= val.HEARTBEAT_INTERVAL_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STATUS_STALE_AFTER_MS"],
        message: `must be longer than HEARTBEAT_INTERVAL_MS (${val.HEARTBEAT_INTERVAL_MS}); about 3x is a good margin`,
      });
    }
    for (const [present, missing, partner] of [
      [val.ADZUNA_APP_ID, val.ADZUNA_APP_KEY, "ADZUNA_APP_KEY"],
      [val.ADZUNA_APP_KEY, val.ADZUNA_APP_ID, "ADZUNA_APP_ID"],
      [val.USAJOBS_API_KEY, val.USAJOBS_USER_AGENT, "USAJOBS_USER_AGENT"],
    ] as const) {
      if (present !== undefined && missing === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [partner], message: "is required with its pair (see .env.example)" });
      }
    }
    if ((val.LATEX_COMPILER_URL === undefined) !== (val.LATEX_COMPILER_TOKEN === undefined)) {
      const unset = val.LATEX_COMPILER_URL === undefined ? "LATEX_COMPILER_URL" : "LATEX_COMPILER_TOKEN";
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [unset],
        message: "set both LATEX_COMPILER_URL and LATEX_COMPILER_TOKEN, or neither",
      });
    }
    const langfuse = { LANGFUSE_HOST: val.LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY: val.LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY: val.LANGFUSE_SECRET_KEY };
    const missing = Object.entries(langfuse).filter(([, v]) => v === undefined).map(([k]) => k);
    if (missing.length > 0 && missing.length < 3) {
      for (const key of missing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "set all of LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY, or none of them",
        });
      }
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
