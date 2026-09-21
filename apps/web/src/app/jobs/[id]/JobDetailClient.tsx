"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { JobDetail } from "../../../lib/jobs/getJobDetail";
import { formatDate, formatPosted, formatSalary, formatSponsorship, formatWorkMode, safeHttpUrl } from "../../../lib/jobs/format";

type State = { kind: "loading" } | { kind: "missing" } | { kind: "error" } | { kind: "ready"; job: JobDetail };

export function JobDetailClient({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${id}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) setState({ kind: "missing" });
        else if (!res.ok) setState({ kind: "error" });
        else setState({ kind: "ready", job: (await res.json()).job });
      })
      .catch(() => !cancelled && setState({ kind: "error" }));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const back = <Link href="/jobs" className="text-sm underline">← All jobs</Link>;

  if (state.kind === "loading") return <p>Loading...</p>;
  if (state.kind === "missing") return <div className="flex flex-col gap-3"><p>Job not found.</p>{back}</div>;
  if (state.kind === "error") return <div className="flex flex-col gap-3"><p role="alert" className="text-red-600">Could not load this job.</p>{back}</div>;

  const job = state.job;
  const rawDiffers = job.salary.isParsed && job.salary.raw;

  return (
    <div className="flex flex-col gap-6">
      {back}
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{job.title}</h1>
        <p className="text-sm text-gray-600">
          {job.companyName}{job.locationRaw ? ` · ${job.locationRaw}` : ""}
          {job.status === "closed" ? " · Closed" : ""}
        </p>
      </header>

      <section aria-labelledby="facts-heading">
        <h2 id="facts-heading" className="mb-2 font-medium">What we read from the posting</h2>
        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-gray-600">Salary</dt>
          <dd>
            {formatSalary(job.salary)}
            {rawDiffers && <div className="text-xs text-gray-500">Source text: “{job.salary.raw}”</div>}
          </dd>
          <dt className="text-gray-600">Work mode</dt>
          <dd>{formatWorkMode(job.workMode)}</dd>
          <dt className="text-gray-600">Minimum experience</dt>
          <dd>
            {job.minExperienceYears !== null ? `${job.minExperienceYears}+ years` : "Not stated"}
            {job.minExperienceEvidence && <div className="text-xs text-gray-500">“{job.minExperienceEvidence}”</div>}
          </dd>
          <dt className="text-gray-600">Visa sponsorship</dt>
          <dd>
            {formatSponsorship(job.sponsorship)}
            {job.sponsorshipConflict && <div className="text-xs text-amber-700">The posting contains conflicting statements — read it before relying on this.</div>}
            {job.sponsorshipEvidence && <div className="text-xs text-gray-500">“{job.sponsorshipEvidence}”</div>}
          </dd>
          <dt className="text-gray-600">Posted</dt>
          <dd>{formatPosted(job)}</dd>
          <dt className="text-gray-600">Last seen open</dt>
          <dd>{formatDate(job.lastVerifiedAt)}</dd>
          {job.employmentType && (<><dt className="text-gray-600">Employment type</dt><dd>{job.employmentType}</dd></>)}
        </dl>
      </section>

      <section aria-labelledby="postings-heading">
        <h2 id="postings-heading" className="mb-2 font-medium">Where it was found</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {job.postings.map((posting) => {
            const href = safeHttpUrl(posting.url);
            return (
              <li key={posting.id}>
                {posting.sourceLabel} ({posting.sourceKind}) · {posting.status === "open" ? "open" : "closed"} · last seen {formatDate(posting.lastSeenAt)}
                {href && <> · <a href={href} target="_blank" rel="noopener noreferrer" className="underline">View posting</a></>}
              </li>
            );
          })}
        </ul>
      </section>

      {job.duplicateCandidates.length > 0 && (
        <section aria-labelledby="duplicates-heading">
          <h2 id="duplicates-heading" className="mb-1 font-medium">Possible duplicates</h2>
          <p className="mb-2 text-xs text-gray-500">These look similar but were not merged automatically. Judge for yourself.</p>
          <ul className="flex flex-col gap-1 text-sm">
            {job.duplicateCandidates.map((candidate) => (
              <li key={candidate.jobId}>
                <Link href={`/jobs/${candidate.jobId}`} className="underline">{candidate.title}</Link>
                {` · ${candidate.companyName}${candidate.locationRaw ? ` · ${candidate.locationRaw}` : ""} · ${Math.round(candidate.similarity * 100)}% title match`}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="description-heading">
        <h2 id="description-heading" className="mb-2 font-medium">Description</h2>
        <pre className="whitespace-pre-wrap text-sm">{job.descriptionText || "No description."}</pre>
      </section>
    </div>
  );
}
