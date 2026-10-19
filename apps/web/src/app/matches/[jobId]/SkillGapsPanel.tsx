"use client";

import { useEffect, useState } from "react";
import { SkillAnswerForm, SKILL_GAPS_CHANGED_EVENT } from "../../skills/SkillAnswerForm";

interface JobSkillGapsView {
  requirementsStatus: "ready" | "missing";
  unanswered: { termKey: string; termDisplay: string; suggestion: string | null }[];
  coveredCount: number; declinedCount: number; profileSkills: string[];
}
type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; view: JobSkillGapsView };

/** Phase 13b design §7: this job's required skills not found in the profile, answered in place. */
export function SkillGapsPanel({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const load = () =>
    fetch(`/api/skill-gaps/${encodeURIComponent(jobId)}`)
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json();
      })
      .then((view: JobSkillGapsView) => setState({ kind: "ready", view }))
      .catch(() => setState({ kind: "error" }));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const res = await fetch(`/api/skill-gaps/${encodeURIComponent(jobId)}/requirements`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setCheckError(body?.error ?? "Could not check this job's requirements.");
        return;
      }
      setState({ kind: "ready", view: body as JobSkillGapsView });
      window.dispatchEvent(new Event(SKILL_GAPS_CHANGED_EVENT));
    } catch {
      setCheckError("Could not check this job's requirements.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <section id="skill-gaps" aria-labelledby="skill-gaps-heading" className="flex flex-col gap-3">
      <h2 id="skill-gaps-heading" className="font-medium">Required skills to verify</h2>
      {state.kind === "loading" && <p>Loading required skills...</p>}
      {state.kind === "error" && <p role="alert" className="text-red-600">Could not load this job&apos;s required skills.</p>}
      {state.kind === "ready" && state.view.requirementsStatus === "missing" && (
        <div className="flex items-center gap-2 text-sm">
          <span>This job&apos;s requirements haven&apos;t been checked yet.</span>
          <button type="button" onClick={check} disabled={checking} className="rounded border px-2 py-1 disabled:opacity-50">
            {checking ? "Checking..." : "Check requirements"}
          </button>
        </div>
      )}
      {state.kind === "ready" && state.view.requirementsStatus === "ready" && (
        <>
          <p className="text-sm text-gray-600">{state.view.coveredCount} covered by your profile · {state.view.declinedCount} you don&apos;t have</p>
          {state.view.unanswered.length === 0 ? (
            <p className="text-sm">Every required skill is covered or answered.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {state.view.unanswered.map((gap) => (
                <li key={gap.termKey} className="flex flex-col gap-1 rounded border p-3">
                  <span className="font-medium">{gap.termDisplay}</span>
                  <SkillAnswerForm termDisplay={gap.termDisplay} suggestion={gap.suggestion} profileSkills={state.view.profileSkills} onSaved={load} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {checkError && <p role="alert" className="text-sm text-red-600">{checkError}</p>}
    </section>
  );
}
