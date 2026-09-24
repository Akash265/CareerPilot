"use client";

import { useEffect, useState } from "react";

type BulletKind = "company" | "role" | "candidate";
type ResearchStatus = "ok" | "no_results" | "failed";

interface PitchEvidenceView {
  id: string;
  kind: "research" | "requirement" | "profile";
  text: string;
  sourceUrl: string | null;
}
interface PitchBulletView {
  kind: BulletKind;
  text: string;
  supported: boolean | null;
  unsupportedReason: string | null;
  evidence: PitchEvidenceView[];
}
interface PitchView {
  id: string;
  version: number;
  origin: "generated" | "user_edited";
  parentPitchId: string | null;
  bullets: PitchBulletView[];
  requiresReview: boolean;
  researchStatus: ResearchStatus;
  researchedAt: string | null;
  generationModel: string | null;
  createdAt: string;
}
interface ResearchView {
  id: string;
  companyName: string;
  status: ResearchStatus;
  researchedAt: string;
  searchCount: number;
}

type ListState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; versions: PitchView[]; research: ResearchView | null; selectedId: string | null };

const BULLET_LABELS: Record<BulletKind, string> = {
  company: "Why this company",
  role: "Why this role",
  candidate: "Why me",
};
const EVIDENCE_LABELS: Record<PitchEvidenceView["kind"], string> = {
  research: "Company research",
  requirement: "Job requirement",
  profile: "Your profile",
};

export function researchAgeLabel(researchedAt: string, now: number = Date.now()): string {
  const days = Math.floor((now - Date.parse(researchedAt)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

/** Evidence URLs come from the web: only http(s) may ever become a link (the server also enforces this). */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function PitchPanel({ jobId }: { jobId: string }) {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [busy, setBusy] = useState<null | "generate" | "refresh" | "save">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const base = `/api/application-pitches/${encodeURIComponent(jobId)}`;

  // A promise chain (state set inside callbacks), matching ResumeOptimizationPanel: the React lint rule
  // react-hooks/set-state-in-effect rejects setState calls in an async function an effect invokes directly.
  //
  // By default a reload keeps whatever version is currently selected (if it still exists in the
  // reloaded list) -- a plain Refresh must never silently jump the selection to a different version
  // out from under an in-progress read. Only generate() and a successful save() pass
  // { selectNewest: true } to explicitly jump to the newest version. The initial mount has no prior
  // selection (state.kind is "loading", not "ready"), so it naturally falls through to newest too.
  const load = (opts: { selectNewest?: boolean } = {}) =>
    fetch(base)
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json();
      })
      .then((body) => {
        const versions = body.versions as PitchView[];
        const research = (body.research as ResearchView | null) ?? null;
        setState((prev) => {
          let selectedId = versions[0]?.id ?? null;
          if (!opts.selectNewest && prev.kind === "ready" && prev.selectedId !== null) {
            if (versions.some((v) => v.id === prev.selectedId)) selectedId = prev.selectedId;
          }
          return { kind: "ready", versions, research, selectedId };
        });
      })
      .catch(() => setState({ kind: "error" }));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const post = async (
    kind: "generate" | "refresh" | "save",
    url: string,
    init: RequestInit,
    fallback: string,
    loadOpts: { selectNewest?: boolean } = {}
  ): Promise<boolean> => {
    setBusy(kind);
    setActionError(null);
    setCopied(false);
    try {
      const res = await fetch(url, { method: "POST", ...init });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setActionError(body?.error ?? fallback);
        return false;
      }
      await load(loadOpts);
      return true;
    } catch {
      setActionError(fallback);
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (state.kind === "loading") return <p>Loading pitch...</p>;
  if (state.kind === "error") return <p role="alert" className="text-red-600">Could not load the pitch.</p>;

  const selected = state.versions.find((v) => v.id === state.selectedId) ?? null;
  const unsupported = selected?.bullets.filter((b) => b.supported === false) ?? [];

  const generate = () => post("generate", `${base}/run`, {}, "Could not generate a pitch.", { selectNewest: true });
  const refresh = () => post("refresh", `${base}/research/refresh`, {}, "Could not refresh company research.");
  const save = async () => {
    if (!selected || !draft) return;
    const ok = await post(
      "save",
      `${base}/edit`,
      { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseVersionId: selected.id, bullets: draft }) },
      "Could not save your edit.",
      { selectNewest: true }
    );
    if (ok) setDraft(null);
  };
  const copy = () => {
    if (!selected) return;
    navigator.clipboard
      .writeText(selected.bullets.map((b) => `• ${b.text}`).join("\n"))
      .then(() => setCopied(true))
      .catch(() => setActionError("Could not copy to the clipboard."));
  };

  return (
    <section aria-labelledby="pitch-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 id="pitch-heading" className="font-medium">Hiring manager pitch</h2>
        <button
          type="button"
          onClick={generate}
          disabled={busy !== null || draft !== null}
          className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {busy === "generate" ? "Generating..." : selected ? "Regenerate" : "Generate Pitch"}
        </button>
      </div>
      {busy === "generate" && (
        <p className="text-sm text-gray-600">Researching a company for the first time can take up to a minute.</p>
      )}
      {actionError && <p role="alert" className="text-sm text-red-600">{actionError}</p>}

      {state.research && (
        <p className="text-sm text-gray-600">
          <span>
            {/* Whether to show the age or the "unavailable" note is driven by the SELECTED pitch's own
                researchStatus snapshot (the research that pitch was actually generated with) when a pitch
                is selected, falling back to the current research's status only when there is none. The
                age value itself always comes from the current research (state.research), never the pitch's
                snapshot timestamp. */}
            {(selected ? selected.researchStatus : state.research.status) === "ok"
              ? `Company researched ${researchAgeLabel(state.research.researchedAt)}`
              : "Web research unavailable — the company bullet is based on posting data only"}
          </span>{" "}
          <button type="button" onClick={refresh} disabled={busy !== null || draft !== null} className="underline disabled:opacity-50">
            {busy === "refresh" ? "Refreshing..." : "Refresh"}
          </button>
        </p>
      )}

      {state.versions.length > 1 && (
        <label className="text-sm">
          Version:{" "}
          <select
            value={state.selectedId ?? ""}
            onChange={(e) => {
              setDraft(null);
              setState({ ...state, selectedId: e.target.value });
            }}
            className="rounded border px-2 py-1"
          >
            {state.versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version} · {v.origin === "user_edited" ? "edited" : "generated"} — {new Date(v.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      )}

      {selected && selected.requiresReview && (
        <div role="alert" className="rounded border border-yellow-600 bg-yellow-50 p-3 text-sm">
          <p className="font-medium text-yellow-800">Review needed</p>
          {unsupported.length > 0 ? (
            <ul>
              {unsupported.map((b) => (
                <li key={b.kind}>{BULLET_LABELS[b.kind]}: {b.unsupportedReason}</li>
              ))}
            </ul>
          ) : (
            <p>The model flagged this pitch for review.</p>
          )}
        </div>
      )}

      {selected && draft === null && (
        <>
          <ul className="flex flex-col gap-2">
            {selected.bullets.map((b) => (
              <li key={b.kind} className="rounded border p-2 text-sm">
                <p className="text-xs font-medium uppercase text-gray-600">
                  {BULLET_LABELS[b.kind]}
                  {b.supported === null && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 normal-case">your wording</span>}
                  {b.supported === false && <span className="ml-2 rounded bg-yellow-100 px-1.5 py-0.5 normal-case">unsupported</span>}
                </p>
                <p>{b.text}</p>
                {b.evidence.length > 0 && (
                  <details className="mt-1 text-xs text-gray-600">
                    <summary>Evidence ({b.evidence.length})</summary>
                    <ul className="ml-4 list-disc">
                      {b.evidence.map((e) => (
                        <li key={e.id}>
                          {EVIDENCE_LABELS[e.kind]}: {e.text}
                          {e.sourceUrl && isHttpUrl(e.sourceUrl) && (
                            <>
                              {" "}
                              <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                                source
                              </a>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button type="button" onClick={() => setDraft(selected.bullets.map((b) => b.text))} disabled={busy !== null} className="rounded border px-3 py-1.5 text-sm">
              Edit
            </button>
            <button type="button" onClick={copy} className="rounded border px-3 py-1.5 text-sm">
              Copy
            </button>
            {copied && <span className="self-center text-sm text-gray-600">Copied</span>}
          </div>
        </>
      )}

      {selected && draft !== null && (
        <div className="flex flex-col gap-2">
          {selected.bullets.map((b, i) => (
            <label key={b.kind} className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{BULLET_LABELS[b.kind]}</span>
              <textarea
                aria-label={BULLET_LABELS[b.kind]}
                value={draft[i]}
                maxLength={600}
                rows={3}
                onChange={(e) => setDraft(draft.map((d, j) => (j === i ? e.target.value : d)))}
                className="rounded border p-2"
              />
            </label>
          ))}
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={busy !== null} className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50">
              {busy === "save" ? "Saving..." : "Save as new version"}
            </button>
            <button type="button" onClick={() => setDraft(null)} disabled={busy !== null} className="rounded border px-3 py-1.5 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {!selected && <p className="text-sm text-gray-600">No pitch generated yet for this job.</p>}
    </section>
  );
}
