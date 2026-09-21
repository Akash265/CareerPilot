"use client";

import { useState } from "react";
import type { JobSourceView } from "../../lib/job-sources/serializeSource";
import { formatDate, formatErrorClass } from "../../lib/jobs/format";

const KIND: Record<JobSourceView["kind"], string> = { greenhouse: "Greenhouse", lever: "Lever", upload: "File upload" };

function lastRunText(source: JobSourceView): string {
  if (source.lastRunStatus === "running") return "Running…";
  if (!source.lastRunStatus || !source.lastRunAt) return "Not run yet";
  const when = formatDate(source.lastRunAt);
  if (source.lastRunStatus === "failed") {
    return `Last run failed (${when}): ${formatErrorClass(source.lastErrorClass ?? "unknown")}`;
  }
  const run = source.lastRun;
  const counts = run
    ? `${run.fetched} fetched · ${run.created} new · ${run.updated} updated · ${run.closed} closed${run.failed ? ` · ${run.failed} unreadable` : ""}`
    : "";
  const note = source.lastErrorClass ? ` — ${formatErrorClass(source.lastErrorClass)}` : run && !run.complete ? " — incomplete, nothing was closed" : "";
  return `Last run ${when}: ${counts}${note}`;
}

export function SourceRow({
  source,
  busy,
  onToggle,
  onRun,
}: {
  source: JobSourceView;
  busy: boolean;
  onToggle: (enabled: boolean, consentConfirmed: boolean) => void;
  onRun: () => void;
}) {
  const [consent, setConsent] = useState(false);
  const needsConsent = source.consentConfirmedAt === null;
  const consentId = `consent-${source.id}`;

  return (
    <li className="flex flex-col gap-2 rounded border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">{source.label}</h3>
        <span className={`rounded px-2 py-0.5 text-xs ${source.enabled ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-700"}`}>
          {source.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>
      <p className="text-sm text-gray-600">
        {KIND[source.kind]}
        {source.slug ? ` · ${source.slug}` : ""}
      </p>
      <p className="text-sm">{lastRunText(source)}</p>

      {needsConsent && (
        <label htmlFor={consentId} className="flex items-start gap-2 text-sm">
          <input id={consentId} type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
          I have reviewed this source&apos;s Terms of Service and I am permitted to ingest its data.
        </label>
      )}

      <div className="flex gap-2">
        {source.enabled ? (
          <button type="button" disabled={busy} onClick={() => onToggle(false, false)} className="rounded border px-3 py-1 text-sm disabled:opacity-50">
            Disable
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || (needsConsent && !consent)}
            onClick={() => onToggle(true, needsConsent && consent)}
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
          >
            Enable
          </button>
        )}
        <button type="button" disabled={busy || !source.enabled} onClick={onRun} className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50">
          Run now
        </button>
      </div>
    </li>
  );
}
