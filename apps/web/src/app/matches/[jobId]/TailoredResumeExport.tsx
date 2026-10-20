"use client";

import { useState } from "react";
import { DownloadButtons, type ExportBody } from "./DownloadButtons";

export interface TailoredDetailsView { pageCount: number | null; pageVerified: boolean; includedCount: number; totalCount: number }

const REASON_LABELS = { no_requirement_match: "no matching job requirement", page_limit: "page limit" } as const;

export function tailoredSummary(d: TailoredDetailsView): string {
  const pages = d.pageCount === null ? "page count not verified" : d.pageCount === 1 ? "1 page" : `${d.pageCount} pages — couldn't fit to one`;
  return `Included ${d.includedCount} of ${d.totalCount} items · ${pages}`;
}

/** Phase 13c: the job-tailored LaTeX resume (PDF + .tex), with what was left out and why (CLAUDE.md §6). */
export function TailoredResumeExport({ jobId, optimizationId, navigate }: { jobId: string; optimizationId: string; navigate?: (url: string) => void }) {
  const [result, setResult] = useState<ExportBody | null>(null);
  const details = result?.document.details ?? null;
  const omitted = result?.omittedItems ?? [];
  return (
    <section aria-labelledby="tailored-resume-heading" className="flex flex-col gap-2 rounded border p-3">
      <h3 id="tailored-resume-heading" className="text-sm font-medium">Tailored resume (LaTeX, 1 page)</h3>
      <p className="text-sm text-gray-600">Keeps the optimizer&apos;s wording first, then the items that mention this job&apos;s requirements. Nothing new is written.</p>
      <DownloadButtons jobId={jobId} kind="tailored_resume" sourceId={optimizationId} formats={["pdf", "tex"]} onExported={setResult} labelPrefix="Download tailored" {...(navigate ? { navigate } : {})} />
      {details && <p className="text-sm">{tailoredSummary(details)}</p>}
      {omitted.length > 0 && (
        <details className="text-sm">
          <summary>Left out ({omitted.length})</summary>
          <ul className="mt-1 list-disc pl-5">
            {omitted.map((item, i) => (
              <li key={i}>
                <span>{item.text}</span> — <span className="text-gray-600">{REASON_LABELS[item.reason]}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
