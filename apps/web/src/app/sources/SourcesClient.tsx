"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { JobSourceView } from "../../lib/job-sources/serializeSource";
import { AddBoardForm } from "./AddBoardForm";
import { DiscoveryPanel } from "./DiscoveryPanel";
import { SourceRow } from "./SourceRow";
import { UploadJobsForm } from "./UploadJobsForm";

const POLL_INTERVAL_MS = 3000;
const POLL_DURATION_MS = 60_000;

export function SourcesClient() {
  const [sources, setSources] = useState<JobSourceView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollUntil, setPollUntil] = useState(0);

  // A promise chain (state is set inside callbacks), matching CareerGoalClient: the React lint rule
  // react-hooks/set-state-in-effect rejects setState calls in an async function that an effect invokes.
  const load = useCallback(
    () =>
      fetch("/api/job-sources")
        .then((res) => {
          if (!res.ok) throw new Error("load failed");
          return res.json();
        })
        .then((body) => {
          setSources(body.sources);
          setLoadFailed(false);
        })
        .catch(() => setLoadFailed(true)),
    []
  );

  useEffect(() => {
    void load();
  }, [load]);

  // After a run is queued, refresh for a minute so the result appears without a manual reload.
  useEffect(() => {
    if (pollUntil <= Date.now()) return;
    const timer = setInterval(() => {
      if (Date.now() > pollUntil) clearInterval(timer);
      else void load();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pollUntil, load]);

  async function call(id: string, path: string, init: RequestInit, onOk: () => void) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(path, init);
      const body = await res.json();
      if (!res.ok) setError(body.error ?? "Something went wrong.");
      else onOk();
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setBusyId(null);
    }
  }

  const toggle = (source: JobSourceView, enabled: boolean, consentConfirmed: boolean) =>
    call(
      source.id,
      `/api/job-sources/${source.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, consentConfirmed }) },
      () => void load()
    );

  const run = (source: JobSourceView) =>
    call(source.id, `/api/job-sources/${source.id}/run`, { method: "POST" }, () => {
      setNotice(`Queued a run for ${source.label}. Make sure the worker is running (pnpm --filter @ai-career/job-ingestion start).`);
      setPollUntil(Date.now() + POLL_DURATION_MS);
      void load();
    });

  // Phase 12: sources the user added, the search providers they switched on, and boards discovery added (up to 300).
  const mine = (sources ?? []).filter((s) => s.origin === "manual");
  const search = (sources ?? []).filter((s) => s.origin === "search");
  const discovered = (sources ?? []).filter((s) => s.origin === "discovered");
  const renderList = (label: string, list: JobSourceView[]) => (
    <ul className="flex flex-col gap-3" aria-label={label}>
      {list.map((source) => (
        <SourceRow
          key={source.id}
          source={source}
          busy={busyId === source.id}
          onToggle={(enabled, consent) => void toggle(source, enabled, consent)}
          onRun={() => void run(source)}
        />
      ))}
    </ul>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-2">
        <AddBoardForm onAdded={() => void load()} />
        <UploadJobsForm
          onUploaded={(message) => {
            setNotice(message);
            setPollUntil(Date.now() + POLL_DURATION_MS);
            void load();
          }}
        />
      </div>

      {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {loadFailed && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-600">Could not load your sources — check your connection and try again.</p>
          <button type="button" onClick={() => void load()} className="w-fit rounded border px-4 py-2 text-sm">Retry</button>
        </div>
      )}

      {sources === null && !loadFailed && <p>Loading...</p>}
      {sources !== null && mine.length === 0 && (
        <p className="text-sm text-gray-600">No sources of your own yet. Add a company board or upload a job export above.</p>
      )}
      {sources !== null && mine.length > 0 && renderList("Job sources", mine)}
      {search.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Search providers</h2>
          {renderList("Search providers", search)}
        </div>
      )}
      {discovered.length > 0 && (
        <details className="flex flex-col gap-2">
          <summary className="cursor-pointer text-sm font-medium">Discovered boards ({discovered.length})</summary>
          {renderList("Discovered boards", discovered)}
        </details>
      )}

      <DiscoveryPanel onChanged={() => void load()} />

      <p className="text-sm">
        <Link href="/jobs" className="underline">Browse ingested jobs →</Link>
      </p>
    </div>
  );
}
