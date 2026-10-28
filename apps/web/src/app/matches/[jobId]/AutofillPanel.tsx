"use client";

import { useEffect, useState } from "react";

/** Dispatched after "Record as applied" so ApplicationPanel reloads (Phase 8). */
export const APPLICATION_RECORDED_EVENT = "application:recorded";

type Status = "queued" | "launching" | "filling" | "awaiting_user" | "submission_detected" | "abandoned" | "needs_manual" | "failed";
interface AuditEntry {
  key: string;
  label: string | null;
  required: boolean;
  canonical: string | null;
  action: "filled" | "flagged" | "skipped";
  reason: string | null;
  verified: boolean | null;
}
interface SessionView {
  id: string;
  status: Status;
  portal: "greenhouse" | "lever";
  formUrl: string;
  errorCode: string | null;
  fieldAudit: AuditEntry[];
  startedAt: string | null;
  createdAt: string;
}
interface Overview {
  support: { supported: true; portal: "greenhouse" | "lever" } | { supported: false; reason: string };
  resumeAvailable: boolean;
  applicationId: string | null;
  sessions: SessionView[];
}

const ACTIVE = new Set<Status>(["queued", "launching", "filling", "awaiting_user"]);
const POLL_MS = 2000;
const QUEUED_HINT_AFTER_MS = 10_000;
const PORTAL_NAME = { greenhouse: "Greenhouse", lever: "Lever" } as const;
const STATUS_TEXT: Record<Status, string> = {
  queued: "Queued",
  launching: "Opening the browser...",
  filling: "Filling the form...",
  awaiting_user: "Waiting for you in the browser window",
  submission_detected: "Submission detected",
  abandoned: "Ended without a detected submission",
  needs_manual: "Needs manual completion",
  failed: "Failed",
};
const UNSUPPORTED_TEXT: Record<string, string> = {
  no_supported_posting: "Autofill is only available for jobs from a Greenhouse or Lever source.",
  invalid_identifiers: "This posting's board or job id cannot be used to build a form address.",
};
const ERROR_TEXT: Record<string, string> = {
  health_check_failed: "The page did not look like the known Greenhouse/Lever form, so nothing was filled.",
  navigation_failed: "The application page could not be loaded.",
  off_host_redirect: "The page redirected away from the application site, so nothing was filled.",
  form_url_not_allowed: "The form address is not on an allowed application site.",
  browser_launch_failed: "Chrome could not be started. Is Google Chrome installed?",
  worker_restart: "The browser worker restarted during this session.",
  enqueue_failed: "The session could not be queued.",
  unexpected_error: "Something went wrong during autofill.",
  cancelled: "Cancelled.",
  timeout: "The window timed out and was closed.",
  window_closed: "The browser window was closed.",
};
const REASON_TEXT: Record<string, string> = {
  unrecognized: "Not recognized",
  ambiguous_match: "More than one field looked like this one",
  no_value: "No value in your profile",
  no_resume_export: "Export a resume PDF for this job first",
  attachment_unavailable: "The file could not be loaded",
  autocomplete_widget: "Pick from the site's suggestions",
  unsupported_control: "Needs a choice in the site's dropdown",
  unrecognized_options: "Unexpected answer options",
  ambiguous_wording: "Question is worded in a way we won't guess — answer it yourself",
  not_auto_filled: "Not filled automatically",
  intentionally_not_filled: "Intentionally not filled (equal-opportunity question)",
  verify_mismatch: "Value did not stick, check it",
  fill_error: "Could not be filled",
  guard_blocked: "Blocked by the safety guard",
};

const isOverview = (v: unknown): v is Overview =>
  typeof v === "object" && v !== null && "support" in v && Array.isArray((v as Overview).sessions);
const fieldName = (a: AuditEntry) => a.label ?? a.canonical ?? "Unnamed field";

function AuditList({ title, entries }: { title: string; entries: AuditEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="list-disc pl-5 text-sm">
        {entries.map((a) => (
          <li key={a.key}>
            {fieldName(a)}
            {a.action === "filled" && a.verified !== false && " ✓"}
            {a.reason && <span className="text-gray-600"> — {REASON_TEXT[a.reason] ?? a.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Phase 8 design §7. Starts an autofill session, polls it while active, shows the field audit, and offers the
 * one-click "Record as applied" (spec §11.8). The user always submits in the browser window themselves.
 */
export function AutofillPanel({ jobId }: { jobId: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queuedLong, setQueuedLong] = useState(false);

  // A promise chain (state is set inside callbacks), matching ResumeOptimizationPanel/SourcesClient: the
  // React lint rule react-hooks/set-state-in-effect rejects a `.then`/`.catch` chained directly onto a call
  // written inside an effect body. `load` is defined once per render and only ever *invoked* bare from an
  // effect, so its own internal chain is out of the rule's reach. A failed background refresh (polling, or
  // the reload after an action) keeps the last good data on screen; only the initial load shows the error.
  const load = (opts: { showError?: boolean } = {}) =>
    fetch(`/api/automation-sessions?jobId=${encodeURIComponent(jobId)}`)
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok || !isOverview(body)) throw new Error("load failed");
        setOverview(body);
        setLoadError(false);
      })
      .catch(() => {
        if (opts.showError) setLoadError(true);
      });

  useEffect(() => {
    load({ showError: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const latest = overview?.sessions[0] ?? null;
  const active = latest !== null && ACTIVE.has(latest.status);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => load(), POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, jobId]);

  // ApplicationPanel's own "Mark as applied" (not this panel's "Record as applied") also dispatches this
  // event, so the Record button here disappears once that application exists instead of 409ing if clicked.
  useEffect(() => {
    const onRecorded = () => void load();
    window.addEventListener(APPLICATION_RECORDED_EVENT, onRecorded);
    return () => window.removeEventListener(APPLICATION_RECORDED_EVENT, onRecorded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // The "queued too long" hint depends on wall-clock time, so it lives in state refreshed on a timer; the
  // React purity lint rule rejects calling the impure Date.now() directly during render.
  useEffect(() => {
    const check = () => {
      if (latest?.status !== "queued") {
        setQueuedLong(false);
        return;
      }
      const createdAtMs = new Date(latest.createdAt).getTime();
      setQueuedLong(Date.now() - createdAtMs > QUEUED_HINT_AFTER_MS);
    };
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
  }, [latest?.status, latest?.createdAt]);

  const post = async (url: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, body === undefined ? { method: "POST" } : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) setError(typeof result.error === "string" ? result.error : "The request failed.");
      return res.ok;
    } catch {
      setError("The request failed.");
      return false;
    } finally {
      setBusy(false);
      await load();
    }
  };

  const start = () => post("/api/automation-sessions", { jobId });
  const cancel = (id: string) => post(`/api/automation-sessions/${encodeURIComponent(id)}/cancel`);
  const record = async (id: string) => {
    if (await post("/api/applications", { jobId, automationSessionId: id })) window.dispatchEvent(new Event(APPLICATION_RECORDED_EVENT));
  };

  const audit = latest?.fieldAudit ?? [];
  // A session cancelled while still queued is "abandoned" with no startedAt (the worker never picked it up),
  // so there was never a browser window the user could have submitted from -- the record prompt would be
  // nonsensical and 409 if clicked (sessionLink requires a real session).
  const canRecord =
    latest !== null &&
    overview?.applicationId === null &&
    (latest.status === "submission_detected" || (latest.status === "abandoned" && latest.startedAt !== null));

  return (
    <section aria-labelledby="autofill-heading" className="flex flex-col gap-2 rounded border p-4">
      <h2 id="autofill-heading" className="font-medium">Application autofill</h2>
      {overview === null && !loadError && <p className="text-sm text-gray-600">Loading...</p>}
      {loadError && <p role="alert" className="text-sm text-red-600">Could not load the autofill status.</p>}
      {overview && !overview.support.supported && (
        <p className="text-sm text-gray-600">{UNSUPPORTED_TEXT[overview.support.reason] ?? "Autofill is not supported for this job."}</p>
      )}
      {overview && overview.support.supported && (
        <>
          <p className="text-sm text-gray-600">
            Chrome opens on this computer with the form filled where possible. Review every field and click Submit yourself; CareerPilot never submits.
          </p>
          <button type="button" onClick={() => void start()} disabled={busy || active || !overview.resumeAvailable}
            className="self-start rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50">
            Open &amp; autofill application ({PORTAL_NAME[overview.support.portal]})
          </button>
          {!overview.resumeAvailable && <p className="text-sm text-gray-600">Export a resume PDF for this job first (use the download buttons).</p>}
        </>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {latest && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 text-sm">
            <p>{STATUS_TEXT[latest.status]}</p>
            {active && (
              <button type="button" onClick={() => void cancel(latest.id)} disabled={busy} className="rounded border px-2 py-0.5">Cancel</button>
            )}
          </div>
          {queuedLong && (
            <p className="text-sm text-gray-600">Still queued. Is the browser worker running? Start it with <code>pnpm --filter @ai-career/browser-worker start</code>.</p>
          )}
          {latest.errorCode && !active && <p className="text-sm text-gray-600">{ERROR_TEXT[latest.errorCode] ?? latest.errorCode}</p>}
          {(latest.status === "needs_manual" || latest.status === "failed") && (
            <a href={latest.formUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline">Open the form yourself</a>
          )}
          {canRecord && latest.status === "submission_detected" && (
            <div className="flex items-center gap-3 rounded bg-green-50 p-2 text-sm">
              <p>Looks like you submitted. Record as applied?</p>
              <button type="button" onClick={() => void record(latest.id)} disabled={busy} className="rounded bg-black px-2 py-0.5 text-white">Record as applied</button>
            </div>
          )}
          {canRecord && latest.status === "abandoned" && (
            <div className="flex items-center gap-3 text-sm">
              <p>Did you submit anyway?</p>
              <button type="button" onClick={() => void record(latest.id)} disabled={busy} className="rounded border px-2 py-0.5">Record as applied</button>
            </div>
          )}
          <AuditList title="Complete these in the browser window, then click Submit yourself" entries={audit.filter((a) => a.action === "flagged")} />
          <AuditList title="Filled" entries={audit.filter((a) => a.action === "filled")} />
          <AuditList title="Not filled" entries={audit.filter((a) => a.action === "skipped")} />
        </div>
      )}

      {overview && overview.sessions.length > 1 && (
        <details className="text-sm">
          <summary>Earlier sessions</summary>
          <ul className="pl-5">
            {overview.sessions.slice(1).map((s) => (
              <li key={s.id}>{new Date(s.createdAt).toLocaleString()} · {STATUS_TEXT[s.status]}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
