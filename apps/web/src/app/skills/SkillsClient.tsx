"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SkillAnswerForm, SKILL_GAPS_CHANGED_EVENT } from "./SkillAnswerForm";

interface GapJobRef { jobId: string; title: string; companyName: string }
interface UnansweredGapView { termKey: string; termDisplay: string; suggestion: string | null; jobCount: number; jobs: GapJobRef[] }
interface VerificationView {
  id: string; termKey: string; termDisplay: string; status: "have" | "dont_have" | "alias";
  evidence: string | null; aliasSkillName: string | null; updatedAt: string;
}
interface SkillGapsOverview { topN: number; unanswered: UnansweredGapView[]; answered: VerificationView[]; jobsWithoutRequirements: number; profileSkills: string[] }

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; overview: SkillGapsOverview };

function answerText(v: VerificationView): string {
  if (v.status === "have") return `${v.termDisplay} — you have it: ${v.evidence}`;
  if (v.status === "alias") return `${v.termDisplay} — same as ${v.aliasSkillName}`;
  return `${v.termDisplay} — you don't have it`;
}

/** Phase 13b design §7: the batched verification page. */
export function SkillsClient() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [editing, setEditing] = useState<string | null>(null);

  // A promise chain, as in ResumeOptimizationPanel (react-hooks/set-state-in-effect).
  const load = () =>
    fetch("/api/skill-gaps")
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json();
      })
      .then((overview: SkillGapsOverview) => setState({ kind: "ready", overview }))
      .catch(() => setState({ kind: "error" }));

  useEffect(() => {
    load();
  }, []);

  const undo = async (v: VerificationView) => {
    await fetch(`/api/skill-verifications/${v.id}`, { method: "DELETE" }).catch(() => null);
    window.dispatchEvent(new Event(SKILL_GAPS_CHANGED_EVENT));
    await load();
  };

  if (state.kind === "loading") return <p>Loading skills...</p>;
  if (state.kind === "error") return <p role="alert" className="text-red-600">Could not load your skills.</p>;
  const { overview } = state;

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="unanswered-heading" className="flex flex-col gap-4">
        <h2 id="unanswered-heading" className="font-medium">Skills your top matches require</h2>
        {overview.jobsWithoutRequirements > 0 && (
          <p className="text-sm text-gray-600">{overview.jobsWithoutRequirements} top matches have no requirements checked yet.</p>
        )}
        {overview.unanswered.length === 0 ? (
          <p className="text-sm text-gray-600">No unanswered required skills in your top {overview.topN} matches.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {overview.unanswered.map((gap) => (
              <li key={gap.termKey} className="flex flex-col gap-2 rounded border p-3">
                <div className="font-medium">{gap.termDisplay}</div>
                <details className="text-sm">
                  <summary>Required by {gap.jobCount} of your top {overview.topN} matches</summary>
                  <ul className="ml-4 list-disc">
                    {gap.jobs.map((j) => (
                      <li key={j.jobId}><Link href={`/matches/${j.jobId}`} className="underline">{j.companyName} — {j.title}</Link></li>
                    ))}
                  </ul>
                </details>
                <SkillAnswerForm termDisplay={gap.termDisplay} suggestion={gap.suggestion} profileSkills={overview.profileSkills} onSaved={load} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="answered-heading" className="flex flex-col gap-2">
        <h2 id="answered-heading" className="font-medium">Your answers</h2>
        {overview.answered.length === 0 ? (
          <p className="text-sm text-gray-600">No answers yet.</p>
        ) : (
          <ul aria-label="Your answers" className="flex flex-col gap-2 text-sm">
            {overview.answered.map((v) => (
              <li key={v.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span>{answerText(v)}</span>
                  <button type="button" onClick={() => setEditing(editing === v.id ? null : v.id)} className="underline" aria-label={`Change ${v.termDisplay}`}>Change</button>
                  <button type="button" onClick={() => undo(v)} className="underline" aria-label={`Undo ${v.termDisplay}`}>Undo</button>
                </div>
                {editing === v.id && (
                  <SkillAnswerForm termDisplay={v.termDisplay} suggestion={v.aliasSkillName} profileSkills={overview.profileSkills}
                    onSaved={() => { setEditing(null); load(); }} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
