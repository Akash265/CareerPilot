# HTTP API

Every route lives in `apps/web/src/app/api/**/route.ts`. Request bodies are validated with Zod in the route (or the
package it calls); the exact schema is the reference, this page is the map.

## Conventions

- **Single user.** There are no accounts ([D1](../DECISIONS.md)); every query runs as `DEFAULT_USER_ID` under Postgres row-level security ([D2](../DECISIONS.md)).
- **Request gate** (`apps/web/src/proxy.ts`, [D177](../DECISIONS.md)) runs before every route:
  - `421 { error: "Unknown host" }` unless `Host` is `localhost`, `127.0.0.1`, `[::1]` or in `ALLOWED_HOSTS`.
  - `403 { error: "Cross-site request blocked" }` for a `POST`/`PUT`/`PATCH`/`DELETE` from another origin.
  - When `APP_ACCESS_TOKEN` is set: `401 { error: "Access token required" }` without the `/unlock` cookie or `Authorization: Bearer <token>` (exempt: `/api/unlock`, `/api/health`).
- **Errors** are `{ error: string }` with a 4xx status: `400` for an invalid body or query, `404` for an unknown (or malformed) id, `409` for a state conflict.
- **Unexpected errors** never leak: `500 { error: "Something went wrong (request <id>)…", requestId }` with an `x-request-id` header; the server logs `request_failed` with the same id ([D169](../DECISIONS.md)).
- **AI budget**: AI routes answer `429 { error, code: "ai_budget_exceeded" }` once the monthly ceiling is reached ([D155](../DECISIONS.md)).
- **Rate limits** ([D178](../DECISIONS.md)): routes marked *ai* (`RATE_LIMIT_AI_PER_MINUTE`, default 10) or *jobs* (`RATE_LIMIT_JOBS_PER_MINUTE`, default 20) are limited per route per minute; over the limit they answer `429 { error, retryAfterSeconds }` with `Retry-After`. `/api/unlock` allows 5 attempts a minute and `/api/health` 60 a minute.

## Routes

| Method | Path | Limit | Purpose |
|---|---|---|---|
| GET | `/api/health` | health | Liveness: database and Redis reachability, Langfuse export status. No token needed. |
| GET | `/api/status` | | Worker heartbeats and queue counts for `/status`; always 200 ([D171](../DECISIONS.md)). |
| GET | `/api/usage` | | Monthly AI spend, budget state and recent calls for `/usage`. |
| POST | `/api/unlock` | unlock | `{ token }` → `204` and the access cookie, `401` wrong token, `404` when no token is configured. |
| GET | `/api/profile` | | The confirmed profile. |
| PATCH | `/api/profile` | ai | Save an edited profile (re-embeds changed facts). |
| POST | `/api/profile/resume` | ai | Multipart `file` (PDF/DOCX, ≤ 10 MB) → stored, then extracted by the AI into a draft for review. |
| DELETE | `/api/profile/resume` | | Deactivate the stored resume. |
| POST | `/api/profile/confirm` | ai | The reviewed profile (`EditableProfile`) → saved, split into facts and embedded. |
| GET | `/api/career-goal` | | The active goal and its constraints. |
| POST | `/api/career-goal/parse` | ai | `{ rawText }` → a parsed draft goal for review. |
| POST | `/api/career-goal/confirm` | ai | `{ goalId, constraints }` → activates that goal version and embeds it. |
| GET | `/api/job-sources` | | Sources with their latest run. |
| POST | `/api/job-sources` | | `{ kind, slug, companyName? }` → a Greenhouse, Lever, Ashby, Workable, SmartRecruiters or Recruitee board, created disabled; enabling it (with consent, [D3](../DECISIONS.md)) is a separate `PATCH`. |
| PATCH | `/api/job-sources/[id]` | | Enable/disable a source or update its settings. |
| POST | `/api/job-sources/[id]/run` | jobs | Queue a fetch now. |
| POST | `/api/job-sources/upload` | jobs | Multipart `file` (CSV/JSON, ≤ 10 MB, ≤ 5,000 rows) + `consentConfirmed=true` → stored and queued for ingestion. |
| GET | `/api/jobs` | | `?q&status&sourceId&page` → normalized jobs. |
| GET | `/api/jobs/[id]` | | One job with its postings. |
| POST | `/api/matches/run` | jobs | Queue a matching run (`202`). |
| GET | `/api/matches/runs/latest` | | The latest matching run's status and counts. |
| GET | `/api/matches` | | `?eligible=true|false` and paging → matches with factor scores and explanations (optionally the personal ranking, §20). |
| GET | `/api/matches/[jobId]` | | One match. |
| PATCH | `/api/matches/[jobId]` | | `{ userAction }` (save, dismiss, …). |
| GET | `/api/resume-optimizations/[jobId]` | | Optimizations for a job, newest first. |
| POST | `/api/resume-optimizations/[jobId]/run` | ai | Generate a grounded, ATS-evaluated resume version. |
| GET | `/api/application-pitches/[jobId]` | | Pitches and the company research for a job. |
| POST | `/api/application-pitches/[jobId]/run` | ai | Generate a hiring-manager pitch. |
| POST | `/api/application-pitches/[jobId]/edit` | | Save the user's edit of a pitch version. |
| POST | `/api/application-pitches/[jobId]/research/refresh` | ai | Re-run company research. |
| GET | `/api/cover-letters/[jobId]` | | Cover letters for a job. |
| POST | `/api/cover-letters/[jobId]/run` | ai | Generate a cover letter. |
| POST | `/api/cover-letters/[jobId]/edit` | | Save the user's edit of a cover-letter version (same paragraph count). |
| GET | `/api/interview-preps/[jobId]` | | Interview preparations for a job. |
| POST | `/api/interview-preps/[jobId]/run` | ai | Generate interview preparation. |
| POST | `/api/documents` | | `{ kind, jobId, sourceId, format }` → render and store a PDF/DOCX. |
| GET | `/api/documents` | | `?jobId=` → generated documents for a job. |
| GET, HEAD | `/api/documents/[id]/download` | | Stream a stored document. |
| GET | `/api/applications` | | `?status&due=1` → tracked applications. |
| POST | `/api/applications` | | `{ jobId }` or `{ external: { companyName, jobTitle, jobUrl? } }`, optional document links, `appliedAt`, `followUpAt`, `notes`. |
| GET | `/api/applications/for-job/[jobId]` | | The application for a job, if any. |
| GET, PATCH, DELETE | `/api/applications/[id]` | | Read, edit or delete an application. |
| POST | `/api/applications/[id]/status` | | Move to a new status (recorded as an event). |
| POST | `/api/applications/[id]/events` | | Add a recruiter / interview / note event. |
| GET | `/api/insights` | | Outcome analytics and the personal response model (§19–§20). |
| GET | `/api/discovery` | | Phase 12: the standing consent, each search provider (key status, on/off) and discovered boards (counts, latest 50). |
| PUT | `/api/discovery/settings` | | `{ consent, autoDiscover }`; withdrawing consent disables discovered and search sources. |
| PUT | `/api/discovery/providers/[kind]` | | `{ enabled }` for one search provider; `409` without consent, `400` without its key, `404` for an unknown provider. |
| POST | `/api/discovery/boards` | jobs | `{ text }` with board links → `{ recognized, added }` pending boards; `409` without consent. |
| GET | `/api/automation-sessions` | | `?jobId=` → autofill sessions. |
| POST | `/api/automation-sessions` | jobs | Start a guarded-autofill session for a job (§18). |
| GET | `/api/automation-sessions/[id]` | | One session with its field audit. |
| POST | `/api/automation-sessions/[id]/cancel` | | Cancel a session. |
