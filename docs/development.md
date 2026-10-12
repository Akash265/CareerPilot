# Development

Setup, day-to-day commands and conventions. First-time setup (Docker infrastructure, `.env`, migrations, starting each worker) is the [README's Quick Start](../README.md#quick-start-local-no-paid-services-required).

## Requirements

Node 22+, pnpm 9 (`packageManager` pins 9.15.0), Docker (Postgres + pgvector, Redis, MinIO via `infra/docker-compose.yml`), and Google Chrome for the browser worker and, locally, the E2E suite.

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js 16 app: pages, `/api` routes, the request gate (`src/proxy.ts`) |
| `packages/*` | Domain logic by capability (`ai`, `matching`, `ingestion`, `resume-optimization`, `application-package`, `applications`, `insights`, `browser`, `document-export`, `storage`), plus `db` (Drizzle schema, migrations, RLS), `config` (env schema), `logging`, `monitoring` |
| `services/*` | BullMQ workers: `job-ingestion` (also runs discovery, Phase 12), `matching-worker`, `maintenance-worker`, `browser-worker` |
| `e2e` | The browser smoke suite and AI stand-ins (`pnpm e2e`) |
| `docs` | Architecture, this guide, [API](api.md), [AI system](ai-system.md); specs and plans under `docs/superpowers/` |

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Web app in dev mode on `http://localhost:3000` (bound to `APP_HOST`, default 127.0.0.1) |
| `pnpm build` | Production build of the web app (also generates the route types `typecheck` needs) |
| `pnpm lint` | ESLint (keep it at 0 warnings: checked before every merge, not enforced by the script) |
| `pnpm typecheck` | `tsc --noEmit` everywhere (after `pnpm build`, or `npx next typegen` in `apps/web`) |
| `pnpm test` | All Vitest suites through Turbo (`--force` to skip the cache) |
| `pnpm e2e` | The browser smoke suite against the built app (below) |
| `pnpm --filter @ai-career/db db:generate` / `db:migrate` | Create a migration from the schema / apply migrations |
| `pnpm --filter <package> eval:*` | Live-model evals (cost money; see [ai-system.md](ai-system.md#evaluation)) |

## Tests

- Suites run against the real `career_intel_test` database and Redis; each file migrates in `beforeAll` under a shared advisory lock. After adding a migration, migrate the test database once before a full run (see the README) — suites starting together on an empty database can collide ([D38](../DECISIONS.md)).
- AI providers are always mocked in `pnpm test`; a real network call from a test is a bug.
- Rate limits are off in web tests (`apps/web/src/test/setup.ts`) because the counters live in shared Redis ([D178](../DECISIONS.md)).
- Timing assertions guard against stalls, not speed: ingestion's share `STALL_BUDGET_MS` ([D176](../DECISIONS.md)).
- Guard tests pin cross-cutting rules: every route wrapped in `withRouteErrors` and the rate-limited set (`apps/web/src/lib/http/*Routes*.test.ts`), no `console.*` in production code, every worker heartbeating and storing content-free job errors, every foreign key indexed.

## E2E suite

```bash
pnpm build && pnpm e2e
```

`e2e/run.mjs` starts a fake Anthropic + Voyage server (which also serves the job-provider APIs discovery is tested against), the built web app (port 3100) with an access token and low rate limits, a second instance with an unreachable database (port 3101), and the ingestion and matching workers, then runs `e2e/smoke.mjs` in headless Chrome: the request gate, unlock, profile → goal → job upload → matching → application, the main pages, rate limits and the message-free 500. It uses `career_intel_test` (it refuses any database not ending in `_test`), Redis database 1, and its own user id, whose rows it wipes first; no paid API is ever called. Set `CHROME_PATH` if Chrome is not at the macOS default; CI installs Playwright's Chromium. Logs and a failure screenshot land in `e2e/.out/`.

## Running it on your network

The web app listens on `127.0.0.1` only. To open it to other devices set `APP_HOST=0.0.0.0`, list the names you will use in `ALLOWED_HOSTS`, and set `APP_ACCESS_TOKEN` (32+ characters, e.g. `openssl rand -hex 32`); you then unlock once per browser at `/unlock`. Without TLS the cookie travels in clear text, so do this only on a network you trust. Behind a reverse proxy, keep the original `Host` header (e.g. nginx `proxy_set_header Host $host`) so the cross-site check compares the right names ([D177](../DECISIONS.md)).

## Conventions

- Test first: a failing test, then the code ([CLAUDE.md](../CLAUDE.md) §10).
- Every meaningful decision gets an entry in [DECISIONS.md](../DECISIONS.md); call paths you change are updated in [FLOW.md](../FLOW.md).
- Logs go through `@ai-career/logging` only, and never include an error's message or any profile content ([D166](../DECISIONS.md)).
- Secrets only in `.env` (git-ignored); `.env.example` documents every variable.

## Troubleshooting

- **`Cannot find name 'LayoutProps'`** in typecheck: the route types are generated; run `pnpm build` (or `npx next typegen` in `apps/web`).
- **`421 Unknown host`**: you reached the app by a name that is not localhost; add it to `ALLOWED_HOSTS`.
- **`403 Cross-site request blocked`**: a write came from another origin (or a proxy rewrote `Host`).
- **`429`** on an AI route: the per-minute limit (`RATE_LIMIT_*`) or the monthly budget (`code: "ai_budget_exceeded"`).
- **A worker shows "stale" on `/status`**: it stopped beating for `STATUS_STALE_AFTER_MS`; check its log.
