#!/usr/bin/env bash
# Runs all of CareerPilot with one command (DECISIONS.md D218): Docker infrastructure, migrations, the web app,
# the four workers and the LaTeX compiler. Press Ctrl-C to stop everything; data in Postgres/MinIO is kept.
# Usage: ./scripts/start.sh   (or: pnpm start)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
LOGS="$ROOT/logs"
COMPOSE=(docker compose -f infra/docker-compose.yml --env-file .env --profile latex)

# Never fails: after the terminal window closes there is nowhere to print, and stopping must still finish.
say() { printf '\033[1m[careerpilot]\033[0m %s\n' "$*" 2>/dev/null || true; }
fail() { printf '\033[1;31m[careerpilot] %s\033[0m\n' "$*" >&2; exit 1; }
env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }

# ---------- preflight ----------
[ -f .env ] || fail "No .env file. Copy .env.example to .env and fill it in first (see README)."
command -v pnpm >/dev/null || fail "pnpm is not installed (see README)."
command -v docker >/dev/null || fail "Docker is not installed."

APP_HOST="$(env_value APP_HOST)"; APP_HOST="${APP_HOST:-127.0.0.1}"
APP_URL="http://$APP_HOST:3000"
if lsof -iTCP:3000 -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  fail "Port 3000 is already in use -- is CareerPilot (or another app) already running? Stop it first."
fi
# Two ingestion or matching workers would fight over the same work, so refuse to start a second copy.
for svc in job-ingestion matching-worker maintenance-worker browser-worker; do
  for pid in $(pgrep -f "src/main.ts" 2>/dev/null || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    if [ "$cwd" = "$ROOT/services/$svc" ]; then
      fail "The $svc worker is already running (process $pid). Stop it first, so there is only ever one."
    fi
  done
done

mkdir -p "$LOGS"

# ---------- Docker ----------
# While Docker Desktop is starting, `docker info` can hang for half a minute, so each check gets its own time limit.
docker_ready() {
  docker info >/dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then wait "$pid"; return $?; fi
    sleep 0.5
  done
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  return 1
}
if ! docker_ready; then
  say "Starting Docker Desktop (this can take a minute)..."
  open -a Docker || fail "Could not start Docker Desktop."
  deadline=$((SECONDS + 180))
  until docker_ready; do
    [ "$SECONDS" -lt "$deadline" ] || fail "Docker did not become ready within 3 minutes. Restart it (Docker menu > Restart, or: docker desktop restart) and run this again."
    sleep 2
  done
fi

# ---------- compiler settings (added once; nothing else in .env is changed) ----------
if [ -z "$(env_value LATEX_COMPILER_TOKEN)" ] || [ -z "$(env_value LATEX_COMPILER_URL)" ]; then
  say "Adding the LaTeX compiler settings to .env (one time)..."
  [ -n "$(env_value LATEX_COMPILER_URL)" ] || printf '\nLATEX_COMPILER_URL=http://127.0.0.1:8090\n' >> .env
  [ -n "$(env_value LATEX_COMPILER_TOKEN)" ] || printf '\nLATEX_COMPILER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
fi

# ---------- stop everything on Ctrl-C (or if a piece dies) ----------
NAMES=(); PIDS=()
STOPPING=0
stop_all() {
  [ "$STOPPING" = 1 ] && return
  STOPPING=1
  trap '' INT TERM HUP
  printf '\n' 2>/dev/null || true
  say "Stopping CareerPilot..."
  for i in "${!PIDS[@]}"; do kill -TERM -- "-${PIDS[$i]}" 2>/dev/null || true; done
  # Wait for every process in each piece's group, not just pnpm: the worker underneath finishes its current job and
  # records that it stopped (its own deadline is 8 s, D175). Anything still running after 20 s is killed.
  for _ in $(seq 1 40); do
    alive=0
    for pid in "${PIDS[@]}"; do pgrep -g "$pid" >/dev/null 2>&1 && alive=1; done
    [ "$alive" = 0 ] && break
    sleep 0.5
  done
  for pid in "${PIDS[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done
  "${COMPOSE[@]}" stop >/dev/null 2>&1 || true
  say "Stopped. Your data is kept; run ./scripts/start.sh to start again."
}
# Ctrl-C, a plain kill, or closing the terminal window all stop everything.
trap 'stop_all; exit 130' INT TERM HUP

# ---------- infrastructure ----------
say "Starting Postgres, Redis and MinIO..."
"${COMPOSE[@]}" up -d --wait postgres redis minio >/dev/null || fail "The infrastructure containers did not become healthy (run: docker compose -f infra/docker-compose.yml ps)."

say "Installing dependencies (quick when nothing changed)..."
pnpm install --frozen-lockfile >"$LOGS/install.log" 2>&1 || { tail -20 "$LOGS/install.log" >&2; fail "pnpm install failed (full log: logs/install.log)."; }

say "Applying database migrations..."
pnpm --filter @ai-career/db db:migrate >"$LOGS/migrate.log" 2>&1 || { tail -20 "$LOGS/migrate.log" >&2; fail "Migrations failed (full log: logs/migrate.log)."; }

say "Building the web app (cached when the code has not changed)..."
pnpm build >"$LOGS/build.log" 2>&1 || { tail -30 "$LOGS/build.log" >&2; fail "The build failed (full log: logs/build.log)."; }

say "Starting the LaTeX compiler..."
"${COMPOSE[@]}" up -d --build latex-compiler >"$LOGS/latex-compiler-build.log" 2>&1 || { tail -20 "$LOGS/latex-compiler-build.log" >&2; fail "The LaTeX compiler did not start (full log: logs/latex-compiler-build.log)."; }

# ---------- web app and workers ----------
start_piece() { # name, then the command
  local name="$1"; shift
  # Job control only while launching: the piece gets its own process group (so stopping it stops its children, and
  # Ctrl-C reaches only this script), while foreground commands stay in the script's group.
  set -m
  "$@" >"$LOGS/$name.log" 2>&1 < /dev/null &
  NAMES+=("$name"); PIDS+=("$!")
  set +m
}
say "Starting the web app and workers..."
start_piece web pnpm --filter web start
start_piece job-ingestion pnpm --filter @ai-career/job-ingestion start
start_piece matching-worker pnpm --filter @ai-career/matching-worker start
start_piece maintenance-worker pnpm --filter @ai-career/maintenance-worker start
CHROME="$(env_value BROWSER_EXECUTABLE_PATH)"; CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ -x "$CHROME" ]; then
  start_piece browser-worker pnpm --filter @ai-career/browser-worker start
else
  say "Warning: Google Chrome was not found, so browser autofill is off (everything else works)."
fi

died() { # name: report a piece that exited, then stop everything
  printf '\033[1;31m[careerpilot] %s stopped unexpectedly. Last lines of logs/%s.log:\033[0m\n' "$1" "$1" >&2 2>/dev/null || true
  tail -20 "$LOGS/$1.log" >&2 2>/dev/null || true
  stop_all
  exit 1
}
check_pieces() { for i in "${!PIDS[@]}"; do kill -0 "${PIDS[$i]}" 2>/dev/null || died "${NAMES[$i]}"; done; }

for _ in $(seq 1 60); do
  check_pieces
  curl -sf -m 5 "$APP_URL/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf -m 5 "$APP_URL/api/health" >/dev/null 2>&1 || { stop_all; fail "The web app did not answer its health check within a minute (see logs/web.log)."; }
for _ in $(seq 1 30); do curl -sf -m 5 http://127.0.0.1:8090/health >/dev/null 2>&1 && break; sleep 1; done
curl -sf -m 5 http://127.0.0.1:8090/health >/dev/null 2>&1 || say "Warning: the LaTeX compiler is not answering; tailored PDF export will say how to start it."

say "CareerPilot is running at $APP_URL  (logs in logs/, worker health at $APP_URL/status)"
say "Press Ctrl-C to stop everything."
open "$APP_URL" >/dev/null 2>&1 || true

while true; do
  check_pieces
  sleep 2
done
