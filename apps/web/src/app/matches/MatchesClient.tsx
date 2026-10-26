"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ModelSummary } from "@ai-career/insights";
import type { MatchListItem } from "../../lib/matching/listMatches";
import { modelUnavailableReason } from "../../lib/insights/formatPersonal";
import {
  readRankPreference, serverRankPreference, subscribeRankPreference, writeRankPreference,
} from "../../lib/insights/rankPreference";
import type { SearchRunView } from "../../lib/searchRuns/searchRuns";
import { explainsMatchingFailure } from "../../lib/searchRuns/format";
import { FindJobsPanel } from "./FindJobsPanel";
import { MatchRow } from "./MatchRow";

const RANK_REASON_ID = "rank-with-history-reason";

interface Result {
  matches: MatchListItem[];
  page: number;
  pageSize: number;
  total: number;
  /** Phase 10b: the order the server actually used, and the response model's status. */
  ranking?: "default" | "personal";
  model?: ModelSummary;
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
  const [error, setError] = useState<string | null>(null);
  const [runFailure, setRunFailure] = useState<string | null>(null);
  // Phase 13a: when the latest search run failed at matching, the panel already says so; one alert is enough.
  const [searchRunExplains, setSearchRunExplains] = useState(false);
  const onRunLoaded = useCallback((run: SearchRunView | null) => setSearchRunExplains(explainsMatchingFailure(run)), []);
  // Phase 10b: per-browser preference; false on the server, the stored choice after hydration.
  const rankWithHistory = useSyncExternalStore(subscribeRankPreference, readRankPreference, serverRankPreference);

  // Only the latest request may update the list: switching filters or the ranking (or the stored ranking choice
  // applying right after hydration) starts a new request while an older one can still be in flight, and a slower
  // older response must not overwrite the newer one.
  const latestRequest = useRef(0);
  const load = useCallback(() => {
    const request = ++latestRequest.current;
    return fetch(`/api/matches?eligible=${!showIneligible}&page=1${rankWithHistory && !showIneligible ? "&rank=personal" : ""}`)
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json();
      })
      .then((body: Result) => {
        if (request !== latestRequest.current) return;
        setResult(body);
        setLoadFailed(false);
      })
      .catch(() => {
        if (request === latestRequest.current) setLoadFailed(true);
      });
  }, [showIneligible, rankWithHistory]);

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
          // An "interrupted" run was cut off by a stop and is re-run by the worker itself (D219): not a failure to report.
          if (run.status === "failed" && run.errorClass !== "interrupted") {
            setRunFailure(`The last matching run failed${run.errorClass ? ` (${run.errorClass})` : ""}. Try Find matching jobs again, or check the matching worker.`);
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

  const modelActive = result?.model?.status === "active";
  const modelReason = result?.model ? modelUnavailableReason(result.model) : null;
  // Excluded jobs are never re-ranked, so an otherwise-active toggle is disabled there and says why.
  const unavailableReason = modelReason ?? (modelActive && showIneligible ? "Excluded jobs are always listed in the default order." : null);

  return (
    <div className="flex flex-col gap-4">
      <FindJobsPanel onResultsChanged={() => { void load(); void checkRunStatus(); }} onRunLoaded={onRunLoaded} />
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showIneligible} onChange={(e) => setShowIneligible(e.target.checked)} />
          Show excluded jobs
        </label>
        <label className="flex items-center gap-2 text-sm">
          {/* Excluded jobs are never re-ranked, so the toggle is shown off and disabled there; the stored choice is kept. */}
          <input
            type="checkbox"
            checked={rankWithHistory && modelActive && !showIneligible}
            disabled={!modelActive || showIneligible}
            aria-describedby={unavailableReason ? RANK_REASON_ID : undefined}
            onChange={(e) => writeRankPreference(e.target.checked)}
          />
          Rank with my history
        </label>
      </div>
      {unavailableReason && <p id={RANK_REASON_ID} className="text-xs text-gray-600">{unavailableReason}</p>}
      {result?.ranking === "personal" && result.model?.blendWeight != null && (
        <p className="text-xs text-gray-600">{`Ranked with your history (weight ${Math.round(result.model.blendWeight * 100)}%)`}</p>
      )}

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {runFailure && !searchRunExplains && <p role="alert" className="text-sm text-red-600">{runFailure}</p>}

      {loadFailed && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-600">Could not load matches — check your connection and try again.</p>
          <button type="button" onClick={() => void load()} className="w-fit rounded border px-4 py-2 text-sm">Retry</button>
        </div>
      )}

      {result === null && !loadFailed && <p>Loading...</p>}
      {result !== null && result.total === 0 && (
        <p className="text-sm text-gray-600">
          {showIneligible ? "No excluded jobs." : "No matches yet — use Find matching jobs to search and rank jobs for your goal."}
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
