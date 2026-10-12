// Phase 11d (D182). `pnpm e2e`: runs the smoke suite against the BUILT web app (run `pnpm build` first) plus the two
// workers the flow needs, all pointed at the test database, Redis database 1 and the local AI stand-ins. Every
// process is started here and always torn down. Logs and failure screenshots go to e2e/.out/.
//
// Safety: refuses to run unless the database name ends in "_test", wipes only the E2E user's rows, and never calls
// a paid API (the AI keys are always replaced by fakes pointing at fakeProviders.mjs).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import IORedis from "ioredis";
import { runSmoke } from "./smoke.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "e2e", ".out");
const E2E_USER = "00000000-0000-0000-0000-000000000e01";
const PORTS = { web: 3100, broken: 3101, fake: 4012 };

/** The repo's .env (when present) under the current environment, which wins; then the E2E overrides. */
function e2eEnv() {
  const env = { ...process.env };
  const file = path.join(REPO, ".env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  }
  const fake = `http://127.0.0.1:${PORTS.fake}`;
  return {
    ...env,
    DATABASE_URL: process.env.E2E_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: process.env.E2E_REDIS_URL ?? "redis://localhost:6379/1",
    DEFAULT_USER_ID: E2E_USER,
    ANTHROPIC_BASE_URL: fake,
    ANTHROPIC_API_KEY: "sk-ant-e2e-fake",
    EMBEDDING_PROVIDER: "voyage",
    VOYAGE_API_BASE: fake,
    VOYAGE_API_KEY: "voyage-e2e-fake",
    // Phase 12: every job-provider base points at the stand-in, keys are blank, and requests are not spaced out.
    ...Object.fromEntries(["GREENHOUSE", "LEVER", "ASHBY", "WORKABLE", "SMARTRECRUITERS", "ADZUNA", "JOOBLE", "USAJOBS", "THEMUSE", "REMOTIVE", "REMOTEOK", "ARBEITNOW", "HN"]
      .map((p) => [`${p}_API_BASE`, fake])),
    RECRUITEE_API_BASE: `${fake}/recruitee/{slug}`,
    ADZUNA_APP_ID: "", ADZUNA_APP_KEY: "", JOOBLE_API_KEY: "", USAJOBS_API_KEY: "", USAJOBS_USER_AGENT: "",
    DISCOVERY_MIN_INTERVAL_MS: "0",
    // Blank = unset (loadEnv): nothing is exported to a real Langfuse from an E2E run.
    LANGFUSE_HOST: "",
    LANGFUSE_PUBLIC_KEY: "",
    LANGFUSE_SECRET_KEY: "",
    APP_ACCESS_TOKEN: randomBytes(32).toString("hex"),
    APP_HOST: "127.0.0.1",
    ALLOWED_HOSTS: "",
    RATE_LIMIT_AI_PER_MINUTE: "3",
    RATE_LIMIT_JOBS_PER_MINUTE: "20",
    HEARTBEAT_INTERVAL_MS: "1000",
    STATUS_STALE_AFTER_MS: "5000",
    LOG_LEVEL: "info",
  };
}

const children = [];

function start(name, command, args, { cwd, env }) {
  const log = createWriteStream(path.join(OUT, `${name}.log`));
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push({ name, child });
  return child;
}

async function stopAll() {
  for (const { child } of children) if (child.exitCode === null) try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  const deadline = Date.now() + 10_000;
  while (children.some(({ child }) => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
}

/** Waits until `url` answers; `anyStatus` for an instance whose health check reports its broken database (5xx). */
async function waitForHttp(url, what, { anyStatus = false, timeoutMs = 60_000 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (anyStatus || res.status < 500) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what} at ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function wipeE2eState(env) {
  const dbName = new URL(env.DATABASE_URL).pathname.slice(1);
  if (!dbName.endsWith("_test")) throw new Error(`refusing to run E2E against "${dbName}": the database name must end in _test`);
  const adminUrl = process.env.E2E_ADMIN_DATABASE_URL ?? `postgres://career_intel:career_intel@localhost:5432/${dbName}`;
  // The clean-up runs as superuser with FK triggers off, so it must be the same _test database.
  if (new URL(adminUrl).pathname.slice(1) !== dbName) throw new Error("E2E_ADMIN_DATABASE_URL must name the same database as the E2E DATABASE_URL");
  // Redis database 0 is the dev workers' queues; the clean-up deletes every bull:* and careerpilot:* key it is pointed at.
  const redisDb = new URL(env.REDIS_URL).pathname.slice(1) || "0";
  if (redisDb === "0") throw new Error("refusing to run E2E against Redis database 0: set E2E_REDIS_URL to another database (default /1)");
  const sql = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    const tables = await sql`SELECT table_name FROM information_schema.columns
                             WHERE table_schema = 'public' AND column_name = 'user_id' ORDER BY table_name`;
    await sql.begin(async (tx) => {
      // Superuser-only: skips FK triggers so the E2E user's rows can be deleted in any order.
      await tx`SET LOCAL session_replication_role = replica`;
      for (const { table_name } of tables) await tx`DELETE FROM ${tx(table_name)} WHERE user_id = ${E2E_USER}`;
    });
  } finally {
    await sql.end();
  }
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  try {
    for (const pattern of ["bull:*", "careerpilot:*"]) {
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
        if (keys.length) await redis.del(...keys);
        cursor = next;
      } while (cursor !== "0");
    }
  } finally {
    redis.disconnect();
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  if (!existsSync(path.join(REPO, "apps/web/.next/BUILD_ID"))) throw new Error("apps/web is not built: run `pnpm build` first");
  const env = e2eEnv();
  await wipeE2eState(env);

  start("fakeProviders", process.execPath, ["fakeProviders.mjs"], { cwd: path.join(REPO, "e2e"), env: { ...env, PORT: String(PORTS.fake) } });
  start("web", "pnpm", ["start"], { cwd: path.join(REPO, "apps/web"), env: { ...env, PORT: String(PORTS.web) } });
  // A second instance whose database is a closed port: every database call fails, so a route error is guaranteed.
  const brokenDb = new URL(env.DATABASE_URL);
  brokenDb.port = "5999";
  start("web-broken", "pnpm", ["start"], { cwd: path.join(REPO, "apps/web"), env: { ...env, PORT: String(PORTS.broken), DATABASE_URL: brokenDb.toString() } });
  for (const svc of ["job-ingestion", "matching-worker"]) {
    start(svc, process.execPath, ["--import", "tsx", "src/main.ts"], { cwd: path.join(REPO, "services", svc), env });
  }

  await waitForHttp(`http://127.0.0.1:${PORTS.fake}/__calls`, "fake providers");
  await waitForHttp(`http://127.0.0.1:${PORTS.web}/api/health`, "web");
  await waitForHttp(`http://127.0.0.1:${PORTS.broken}/api/health`, "broken web", { anyStatus: true });

  await runSmoke({
    base: `http://127.0.0.1:${PORTS.web}`,
    broken: `http://127.0.0.1:${PORTS.broken}`,
    fake: `http://127.0.0.1:${PORTS.fake}`,
    token: env.APP_ACCESS_TOKEN,
    aiLimit: Number(env.RATE_LIMIT_AI_PER_MINUTE),
    brokenLog: path.join(OUT, "web-broken.log"),
    out: OUT,
  });
}

let code = 0;
try {
  await main();
  console.log(JSON.stringify({ done: true }));
} catch (error) {
  code = 1;
  console.log(JSON.stringify({ done: false, error: error instanceof Error ? error.message : String(error) }));
} finally {
  await stopAll();
}
process.exit(code);
