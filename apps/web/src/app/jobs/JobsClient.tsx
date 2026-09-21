"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { JobListItem } from "../../lib/jobs/listJobs";
import { formatPosted, formatSalary, formatSponsorship, formatWorkMode } from "../../lib/jobs/format";

type Status = "open" | "closed" | "all";
interface Filters {
  q: string;
  status: Status;
}
interface Result {
  jobs: JobListItem[];
  page: number;
  pageSize: number;
  total: number;
}

export function JobsClient() {
  const [draftQuery, setDraftQuery] = useState("");
  const [draftStatus, setDraftStatus] = useState<Status>("open");
  const [applied, setApplied] = useState<Filters>({ q: "", status: "open" });
  const [page, setPage] = useState(1);
  // The result on screen, remembered together with the filters it answers.
  const [loaded, setLoaded] = useState<{ result: Result; filters: Filters } | null>(null);
  const result = loaded?.result ?? null;
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // A promise chain, not async/await: see the note in SourcesClient (react-hooks/set-state-in-effect).
  // `cancelled` makes a response that arrives after a newer request (or after unmount) a no-op, so the list on screen
  // always belongs to the latest `applied`/`page`; Retry bumps `reloadKey` to re-run this effect.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ status: applied.status, page: String(page) });
    if (applied.q) params.set("q", applied.q);
    fetch(`/api/jobs?${params.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json();
      })
      .then((body: Result) => {
        if (cancelled) return;
        setLoaded({ result: body, filters: applied });
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, page, reloadKey]);

  function search() {
    setPage(1);
    setApplied({ q: draftQuery.trim(), status: draftStatus });
  }

  const from = result && result.total > 0 ? (result.page - 1) * result.pageSize + 1 : 0;
  const to = result ? Math.min(result.page * result.pageSize, result.total) : 0;
  // While a different page or filter than the one on screen is in flight (or failed), paging from the stale result's
  // bounds could request a page past the end, so Previous/Next wait (Retry or a new search recovers).
  const paging = loaded !== null && (loaded.filters !== applied || loaded.result.page !== page);

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="job-search" className="text-sm">Title or company</label>
          <input id="job-search" value={draftQuery} onChange={(e) => setDraftQuery(e.target.value)} className="rounded border px-2 py-1" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="job-status" className="text-sm">Show</label>
          <select id="job-status" value={draftStatus} onChange={(e) => setDraftStatus(e.target.value as Status)} className="rounded border px-2 py-1">
            <option value="open">Open jobs</option>
            <option value="closed">Closed jobs</option>
            <option value="all">All jobs</option>
          </select>
        </div>
        <button type="submit" className="rounded bg-black px-4 py-1.5 text-white">Search</button>
      </form>

      {failed && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-600">Could not load jobs — check your connection and try again.</p>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="w-fit rounded border px-4 py-2 text-sm">Retry</button>
        </div>
      )}
      {result === null && !failed && <p>Loading...</p>}

      {result !== null && result.total === 0 && (
        <p className="text-sm text-gray-600">
          No jobs match. <Link href="/sources" className="underline">Add a source and run it</Link>, or change the filters.
        </p>
      )}

      {result !== null && result.total > 0 && (
        <>
          <p className="text-sm text-gray-600">Showing {from}–{to} of {result.total}</p>
          <ul className="flex flex-col gap-3" aria-label="Jobs">
            {result.jobs.map((job) => (
              <li key={job.id} className="flex flex-col gap-1 rounded border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={`/jobs/${job.id}`} className="font-medium underline">{job.title}</Link>
                  {job.status === "closed" && <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">Closed</span>}
                </div>
                <p className="text-sm">{job.companyName}{job.locationRaw ? ` · ${job.locationRaw}` : ""} · {formatWorkMode(job.workMode)}</p>
                <p className="text-sm">
                  {formatSalary(job.salary)} · {formatSponsorship(job.sponsorship)}
                  {job.minExperienceYears !== null ? ` · ${job.minExperienceYears}+ years experience` : ""}
                </p>
                <p className="text-xs text-gray-500">{formatPosted(job)}</p>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button type="button" disabled={paging || result.page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border px-3 py-1 text-sm disabled:opacity-50">Previous</button>
            <button type="button" disabled={paging || to >= result.total} onClick={() => setPage((p) => p + 1)} className="rounded border px-3 py-1 text-sm disabled:opacity-50">Next</button>
          </div>
        </>
      )}
    </div>
  );
}
