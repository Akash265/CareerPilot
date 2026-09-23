"use client";

import { useEffect, useState } from "react";

interface SelectedBulletView {
  sourceFactId: string;
  sourceType: string;
  originalText: string;
  optimizedText: string;
  changeType: "unchanged" | "reordered" | "reworded";
  justification: string;
}
interface RejectedClaimView {
  sourceFactId: string;
  reason: string;
}
interface EvaluationView {
  requiredKeywordCoverage: number;
  preferredKeywordCoverage: number;
  semanticSimilarity: number | null;
  factualConsistency: number;
  actionVerbScore: number;
  machineReadabilityScore: number;
  overallScore: number;
  evaluatorVersion: string;
}
interface OptimizationView {
  id: string;
  version: number;
  selectedBullets: SelectedBulletView[];
  addedTerms: string[];
  unsupportedClaimsDetected: string[];
  rejectedClaims: RejectedClaimView[];
  requiresReview: boolean;
  generationModel: string;
  createdAt: string;
  evaluation: EvaluationView;
}

type ListState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; optimizations: OptimizationView[]; selectedId: string | null };

const SCORE_LABELS: [keyof EvaluationView, string][] = [
  ["requiredKeywordCoverage", "Required keywords"],
  ["preferredKeywordCoverage", "Preferred keywords"],
  ["semanticSimilarity", "Semantic fit"],
  ["factualConsistency", "Factual consistency"],
  ["actionVerbScore", "Action verbs"],
  ["machineReadabilityScore", "Machine readability"],
];

export function ResumeOptimizationPanel({ jobId }: { jobId: string }) {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // A promise chain (state is set inside callbacks), matching SourcesClient/CareerGoalClient: the React lint rule
  // react-hooks/set-state-in-effect rejects setState calls in an async function that an effect invokes directly.
  const load = () =>
    fetch(`/api/resume-optimizations/${encodeURIComponent(jobId)}`)
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json();
      })
      .then((body) => {
        const optimizations = body.optimizations as OptimizationView[];
        setState({ kind: "ready", optimizations, selectedId: optimizations[0]?.id ?? null });
      })
      .catch(() => setState({ kind: "error" }));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const generate = async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await fetch(`/api/resume-optimizations/${encodeURIComponent(jobId)}/run`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setGenerateError(body?.error ?? "Could not generate an optimized resume.");
        return;
      }
      await load();
    } catch {
      setGenerateError("Could not generate an optimized resume.");
    } finally {
      setGenerating(false);
    }
  };

  if (state.kind === "loading") return <p>Loading resume optimization...</p>;
  if (state.kind === "error") return <p role="alert" className="text-red-600">Could not load resume optimizations.</p>;

  const selected = state.optimizations.find((o) => o.id === state.selectedId) ?? null;

  return (
    <section aria-labelledby="resume-optimization-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 id="resume-optimization-heading" className="font-medium">Resume optimization</h2>
        <button
          type="button"
          onClick={generate}
          disabled={generating}
          className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {generating ? "Generating..." : selected ? "Regenerate" : "Optimize Resume"}
        </button>
      </div>
      {generateError && <p role="alert" className="text-sm text-red-600">{generateError}</p>}

      {state.optimizations.length > 1 && (
        <label className="text-sm">
          Version:{" "}
          <select
            value={state.selectedId ?? ""}
            onChange={(e) => setState({ ...state, selectedId: e.target.value })}
            className="rounded border px-2 py-1"
          >
            {state.optimizations.map((o) => (
              <option key={o.id} value={o.id}>
                v{o.version} — {new Date(o.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      )}

      {selected && (
        <>
          {selected.requiresReview && (
            <div role="alert" className="rounded border border-yellow-600 bg-yellow-50 p-3 text-sm">
              <p className="font-medium text-yellow-800">Review needed</p>
              {selected.unsupportedClaimsDetected.length > 0 && (
                <p>The model flagged claims it could not fully ground: {selected.unsupportedClaimsDetected.join("; ")}</p>
              )}
              {selected.rejectedClaims.length > 0 && (
                <p>{selected.rejectedClaims.length} proposed change(s) were rejected because they did not cite real profile evidence, and were not applied.</p>
              )}
            </div>
          )}

          <div>
            <h3 className="mb-1 text-sm font-medium">ATS scorecard (internal signal only — not a guarantee of passing any real ATS)</h3>
            <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
              <div className="contents">
                <dt className="text-gray-600">Overall</dt>
                <dd className="font-semibold">{selected.evaluation.overallScore}/100</dd>
              </div>
              {SCORE_LABELS.map(([key, label]) => {
                const value = selected.evaluation[key];
                return (
                  <div key={key} className="contents">
                    <dt className="text-gray-600">{label}</dt>
                    <dd>{value === null ? "Not comparable" : `${value}%`}</dd>
                  </div>
                );
              })}
            </dl>
          </div>

          {selected.addedTerms.length > 0 && (
            <div>
              <h3 className="text-sm font-medium">Added terms</h3>
              <p className="text-sm">{selected.addedTerms.join(", ")}</p>
            </div>
          )}

          <div>
            <h3 className="mb-1 text-sm font-medium">Optimized bullets</h3>
            <ul className="flex flex-col gap-2">
              {selected.selectedBullets.map((b) => (
                <li key={b.sourceFactId} className="rounded border p-2 text-sm">
                  <span className="mr-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs uppercase text-gray-600">{b.changeType}</span>
                  <p>{b.optimizedText}</p>
                  {b.originalText !== b.optimizedText && <p className="mt-1 text-xs text-gray-500">Was: {b.originalText}</p>}
                  <p className="mt-1 text-xs text-gray-500">{b.justification}</p>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {!selected && state.optimizations.length === 0 && (
        <p className="text-sm text-gray-600">No optimized resume generated yet for this job.</p>
      )}
    </section>
  );
}
