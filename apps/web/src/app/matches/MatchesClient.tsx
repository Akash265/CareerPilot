"use client";

import { useCallback, useEffect, useState } from "react";
import type { MatchListItem } from "../../lib/matching/listMatches";
import { MatchRow } from "./MatchRow";

const POLL_INTERVAL_MS = 3000;
const POLL_DURATION_MS = 60_000;

interface Result {
  matches: MatchListItem[];
  page: number;
  pageSize: number;
  total: number;
}

interface RunStatus {
  status: "running" | "completed" | "failed";
  errorClass: string | null;
}

export function MatchesClient() {
  const [showIneligible, setShowIneligible] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runFailure, setRunFailure] = useState<string | null>(null);
  const [pollUntil, setPollUntil] = useState(0);

  const load = useCallback(
    () =>
      fetch(`/api/matches?eligible=${!showIneligible}&page=1`)
        .then((res) => {
          if (!res.ok) throw new Error("load failed");
          return res.json();
        })
        .then((body: Result) => {
          setResult(body);
          setLoadFailed(false);
        })
        .catch(() => setLoadFailed(true)),
    [showIneligible]
  );

  // A queued run finishes on the worker, out of band from this request. Enqueuing only proves the job was
  // accepted, not that it succeeded — so this checks the run's outcome (GET /api/matches/runs/latest) on
  // mount (to surface a run that already failed, e.g. before a reload) and on every poll tick after Find
  // Matches (to catch a run that fails after being enqueued, e.g. an LLM/embedding outage). A "failed" run
  // is shown as an alert instead of silently leaving the list unchanged, and stops further polling since
  // waiting longer will not resolve it. "running" and "completed" both clear any stale failure banner from
  // a prior run — "running" specifically because POST /api/matches/run only pushes a queue job; it does not
  // create the matching_runs row, which the worker creates once it actually dequeues the job. So this
  // endpoint can briefly still report the *previous* run (possibly "failed") right after a successful
  // re-queue, until the worker catches up — deliberately not called immediately after enqueuing (only from
  // the poll loop below) to avoid resurfacing that stale failure before the new row exists.
  const checkRunStatus = useCallback(
    () =>
      fetch("/api/matches/runs/latest")
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { run: RunStatus | null } | null) => {
          const run = body?.run;
          if (!run) return;
          if (run.status === "failed") {
            setRunFailure(`The last matching run failed${run.errorClass ? ` (${run.errorClass})` : ""}. Try Find Matches again, or check the worker logs.`);
            setPollUntil(0);
          } else {
            setRunFailure(null);
          }
        })
        .catch(() => {}),
    []
  );

  useEffect(() => {
    void load();
    void checkRunStatus();
  }, [load, checkRunStatus]);

  useEffect(() => {
    if (pollUntil <= Date.now()) return;
    const timer = setInterval(() => {
      if (Date.now() > pollUntil) clearInterval(timer);
      else {
        void load();
        void checkRunStatus();
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pollUntil, load, checkRunStatus]);

  async function findMatches() {
    setError(null);
    setNotice(null);
    setRunFailure(null);
    try {
      const res = await fetch("/api/matches/run", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Something went wrong.");
        return;
      }
      setNotice("Queued a matching run. Make sure the worker is running (pnpm --filter @ai-career/matching-worker start).");
      setPollUntil(Date.now() + POLL_DURATION_MS);
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    }
  }

  async function act(jobId: string, userAction: "saved" | "dismissed") {
    setBusyJobId(jobId);
    setError(null);
    try {
      const res = await fetch(`/api/matches/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAction }),
      });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? "Something went wrong.");
        return;
      }
      await load();
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setBusyJobId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" onClick={() => void findMatches()} className="rounded bg-black px-4 py-1.5 text-sm text-white">
          Find Matches
        </button>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showIneligible} onChange={(e) => setShowIneligible(e.target.checked)} />
          Show excluded jobs
        </label>
      </div>

      {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {runFailure && <p role="alert" className="text-sm text-red-600">{runFailure}</p>}

      {loadFailed && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-600">Could not load matches — check your connection and try again.</p>
          <button type="button" onClick={() => void load()} className="w-fit rounded border px-4 py-2 text-sm">Retry</button>
        </div>
      )}

      {result === null && !loadFailed && <p>Loading...</p>}
      {result !== null && result.total === 0 && (
        <p className="text-sm text-gray-600">
          {showIneligible ? "No excluded jobs." : "No matches yet — confirm a career goal, run job ingestion, then Find Matches."}
        </p>
      )}
      {result !== null && result.total > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Matches">
          {result.matches.map((item) => (
            <MatchRow
              key={item.jobId}
              item={item}
              busy={busyJobId === item.jobId}
              onSave={() => void act(item.jobId, "saved")}
              onDismiss={() => void act(item.jobId, "dismissed")}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
