"use client";

import { useCallback, useEffect, useState } from "react";
import type { DiscoveryView } from "../../lib/discovery/discovery";

const STATUS_TEXT: Record<string, string> = { pending: "waiting to be checked", enabled: "added", rejected: "rejected", gone: "gone" };
const ORIGIN_TEXT: Record<string, string> = {
  posting_link: "found in a job posting", pasted: "added by you", name_probe: "found by name guess", web_search: "found by web search",
};
// Fixed codes written by validateBoards (discover.ts) and checkCompany (companyCheck.ts).
const REJECT_TEXT: Record<string, string> = {
  company_mismatch: "different company", company_unverified: "company could not be confirmed", no_jobs: "no open jobs",
  not_found: "board not found", invalid_slug: "not a valid board address", http_error: "the site returned an error",
  response_too_large: "the site's answer was too large", gave_up: "could not be checked for a week",
};

type RecentBoard = DiscoveryView["boards"]["recent"][number];
function boardLine(b: RecentBoard): string {
  const status = b.status === "rejected" && b.rejectReason
    ? `rejected: ${REJECT_TEXT[b.rejectReason] ?? b.rejectReason}`
    : STATUS_TEXT[b.status] ?? b.status;
  const origin = ORIGIN_TEXT[b.origin] ?? b.origin;
  return `(${b.kind}) — ${status} · ${origin}${b.foundVia ? ` via ${b.foundVia}` : ""}`;
}

/**
 * Phase 12 (D185-D187): the standing permission, the goal-driven search providers, automatic discovery of company
 * boards from posting links, and pasted board links. The ingestion worker does the fetching and validating.
 */
export function DiscoveryPanel({ onChanged }: { onChanged?: () => void }) {
  const [view, setView] = useState<DiscoveryView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paste, setPaste] = useState("");

  // A promise chain (state set in callbacks), as in SourcesClient: react-hooks/set-state-in-effect.
  const load = useCallback(
    () =>
      fetch("/api/discovery")
        .then((res) => {
          if (!res.ok) throw new Error("load failed");
          return res.json();
        })
        .then((body: DiscoveryView) => {
          setView(body);
          setLoadFailed(false);
        })
        .catch(() => setLoadFailed(true)),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function send(method: string, url: string, body: unknown, onOk?: (json: Record<string, unknown>) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) setError(typeof json.error === "string" ? json.error : "Something went wrong.");
      else onOk?.(json);
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setBusy(false);
      void load();
      onChanged?.();
    }
  }

  if (loadFailed) return <p role="alert" className="text-sm text-red-600">Could not load discovery settings.</p>;
  if (!view) return <p className="text-sm">Loading discovery…</p>;

  const consented = view.settings.consentedAt !== null;
  const settings = (consent: boolean, autoDiscover: boolean) => send("PUT", "/api/discovery/settings", { consent, autoDiscover });
  const { counts } = view.boards;

  return (
    <section aria-labelledby="discovery-heading" className="flex flex-col gap-4 rounded border p-4">
      <h2 id="discovery-heading" className="text-lg font-semibold">Discover jobs automatically</h2>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox" checked={consented} disabled={busy}
          onChange={(e) => void settings(e.target.checked, e.target.checked && view.settings.autoDiscover)}
        />
        <span>
          I have permission to collect job postings from the providers I switch on below and from the company boards found
          through them.
        </span>
      </label>

      <fieldset className="flex flex-col gap-2" disabled={!consented || busy}>
        <legend className="text-sm font-medium">Search providers — searched with your career goal&apos;s roles and places</legend>
        {view.providers.map((p) => (
          <div key={p.kind} className="flex flex-col">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox" checked={p.enabled} disabled={!consented || busy || (!p.keyConfigured && !p.enabled)}
                onChange={(e) => void send("PUT", `/api/discovery/providers/${p.kind}`, { enabled: e.target.checked })}
              />
              {p.label}
            </label>
            {!p.keyConfigured && (
              <span className="ml-6 text-xs text-gray-500">Needs {p.missingKeys.join(" and ")} in .env</span>
            )}
          </div>
        ))}
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox" checked={view.settings.autoDiscover} disabled={!consented || busy}
          onChange={(e) => void settings(true, e.target.checked)}
        />
        <span>Add company boards linked from fetched postings automatically (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee)</span>
      </label>

      <div className="flex flex-col gap-2">
        <label htmlFor="discovery-paste" className="text-sm font-medium">Paste board links (one or many)</label>
        <textarea
          id="discovery-paste" value={paste} onChange={(e) => setPaste(e.target.value)} rows={3}
          placeholder="https://jobs.ashbyhq.com/linear https://boards.greenhouse.io/gitlab" className="rounded border px-2 py-1 text-sm"
        />
        <button
          type="button" disabled={!consented || busy || paste.trim() === ""}
          onClick={() => void send("POST", "/api/discovery/boards", { text: paste }, (json) => {
            setNotice(`${json.recognized} boards recognized, ${json.added} new. They are checked by the ingestion worker.`);
            setPaste("");
          })}
          className="w-fit rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Add boards
        </button>
      </div>

      {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <p className="text-sm text-gray-700">
        Boards: {counts.enabled} enabled · {counts.pending} waiting · {counts.rejected} rejected · {counts.gone} gone
      </p>
      {view.boards.recent.length > 0 && (
        <ul aria-label="Recently discovered boards" className="flex flex-col gap-1 text-sm">
          {view.boards.recent.map((b) => (
            <li key={`${b.kind}:${b.slug}`}>
              {b.label ?? b.slug} <span className="text-gray-500">{boardLine(b)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
