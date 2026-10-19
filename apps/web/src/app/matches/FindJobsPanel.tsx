"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchRunView } from "../../lib/searchRuns/searchRuns";
import { runFailureText, seedingLine, sourceLine } from "../../lib/searchRuns/format";

const POLL_MS = 3000;
const QUEUED_WARNING_MS = 30_000;
const ACTIVE = new Set(["queued", "running", "matching"]);
const STAGE: Record<string, string> = { queued: "Searching — starting…", running: "Searching job sources…", matching: "Ranking jobs against your goal…" };

/**
 * Phase 13a: "Find matching jobs" -- one click refreshes sources, discovers companies, and ranks. Shows a one-time
 * consent step, per-source progress, and plain-language failures. Calls `onResultsChanged` when a run finishes.
 */
export function FindJobsPanel({ onResultsChanged }: { onResultsChanged: () => void }) {
  const [run, setRun] = useState<SearchRunView | null>(null);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [needsGoal, setNeedsGoal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Render must stay pure, so "now" is sampled whenever a poll result arrives.
  const [now, setNow] = useState(0);
  const lastStatus = useRef<string | null>(null);

  // Promise chaining (not async/await) so the mount effect below never sets state synchronously.
  const refresh = useCallback(
    () =>
      fetch("/api/search-runs/latest")
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { run: SearchRunView | null } | null) => {
          if (!body) return;
          const previous = lastStatus.current;
          lastStatus.current = body.run?.status ?? null;
          setNow(Date.now());
          setRun(body.run);
          if (previous && ACTIVE.has(previous) && body.run && !ACTIVE.has(body.run.status)) onResultsChanged();
        })
        .catch(() => {
          // A missed poll is retried on the next tick.
        }),
    [onResultsChanged]
  );

  useEffect(() => { void refresh(); }, [refresh]);
  const active = run !== null && ACTIVE.has(run.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  async function start() {
    setError(null);
    setNeedsGoal(false);
    setBusy(true);
    try {
      const res = await fetch("/api/search-runs", { method: "POST" });
      const body = await res.json();
      if (res.status === 409 && body.code === "consent_required") { setNeedsConsent(true); return; }
      if (res.status === 409 && body.code === "no_active_goal") { setNeedsGoal(true); return; }
      if (!res.ok) { setError(body.error ?? "Something went wrong."); return; }
      lastStatus.current = body.run.status;
      setRun(body.run);
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function allowAndSearch() {
    setBusy(true);
    try {
      const res = await fetch("/api/discovery/quick-start", { method: "POST" });
      if (!res.ok) { setError("Could not save the permission. Try again."); return; }
      setNeedsConsent(false);
    } catch {
      setError("Could not reach the server — check your connection and try again.");
      return;
    } finally {
      setBusy(false);
    }
    await start();
  }

  const queuedTooLong = run?.status === "queued" && now - new Date(run.createdAt).getTime() > QUEUED_WARNING_MS;
  const seeding = run ? seedingLine(run.seeding) : "";

  return (
    <section aria-label="Find matching jobs" className="flex flex-col gap-2">
      <button type="button" onClick={() => void start()} disabled={busy || active}
        className="w-fit rounded bg-black px-4 py-1.5 text-sm text-white disabled:opacity-50">
        Find matching jobs
      </button>

      {needsConsent && (
        <div className="flex flex-col gap-2 rounded border p-3 text-sm">
          <p>
            To search for you, CareerPilot fetches public job listings from job-search APIs and the public job boards of
            companies it finds (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee), politely and within each
            site&apos;s limits. You can change this any time on <Link href="/sources" className="underline">Sources</Link>.
          </p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} />
            I confirm I may use these job sources for my own job search
          </label>
          <button type="button" disabled={!consentChecked || busy} onClick={() => void allowAndSearch()}
            className="w-fit rounded border px-3 py-1 disabled:opacity-50">
            Allow and search
          </button>
        </div>
      )}

      {needsGoal && (
        <p role="alert" className="text-sm text-red-600">
          Confirm a <Link href="/career-goal" className="underline">career goal</Link> before finding jobs.
        </p>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {run && active && <p role="status" className="text-sm">{STAGE[run.status]}</p>}
      {queuedTooLong && <p className="text-sm text-amber-700">Still waiting to start — the job-ingestion worker may not be running.</p>}
      {run?.status === "failed" && <p role="alert" className="text-sm text-red-600">{runFailureText(run.errorCode)}</p>}
      {run && run.sources.length > 0 && (
        <ul aria-label="Sources" className="text-xs text-gray-700">
          {run.sources.map((s) => <li key={s.sourceId}>{sourceLine(s)}</li>)}
        </ul>
      )}
      {seeding && <p className="text-xs text-gray-700">{seeding}</p>}
    </section>
  );
}
