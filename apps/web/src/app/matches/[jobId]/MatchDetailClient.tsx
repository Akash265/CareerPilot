"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ResponsePrediction } from "@ai-career/insights";
import { ApplicationPanel } from "./ApplicationPanel";
import { AutofillPanel } from "./AutofillPanel";
import { SkillGapsPanel } from "./SkillGapsPanel";
import { ResumeOptimizationPanel } from "./ResumeOptimizationPanel";
import { PitchPanel } from "./PitchPanel";
import { CoverLetterPanel } from "./CoverLetterPanel";
import { InterviewPrepPanel } from "./InterviewPrepPanel";
import { DocumentsList } from "./DocumentsList";
import { formatFactorPushes, formatLikelyResponse, formatSampleSize } from "../../../lib/insights/formatPersonal";

interface JobView {
  id: string;
  title: string;
  companyName: string;
  locationRaw: string | null;
  workMode: string;
  descriptionText: string;
}
interface MatchView {
  eligible: boolean;
  ineligibleReason: string | null;
  overallScore: number | null;
  factors: Record<string, number | null> | null;
  explanation: { strongMatches: string[]; partialMatches: string[]; gaps: string[]; summary: string } | null;
  userAction: "none" | "saved" | "dismissed";
  /** Phase 10b: present only when the personal response model is active and the match is eligible. */
  personal?: ResponsePrediction | null;
}

/** Phase 10b: the sample behind the personal prediction (from the response's `model` summary). */
interface ModelSample {
  decided: number;
  responses: number;
}

type Outcome =
  | { kind: "missing" }
  | { kind: "error" }
  | { kind: "ready"; job: JobView; match: MatchView; applicationId: string | null; model: ModelSample | null };
type State = { kind: "loading" } | Outcome;

const FACTOR_LABELS: [string, string][] = [
  ["skills", "Skills"], ["experience", "Experience"], ["location", "Location"], ["sponsorship", "Sponsorship"],
  ["role", "Role"], ["salary", "Salary"], ["industry", "Industry"], ["freshness", "Freshness"], ["semantic", "Fit"],
];

export function MatchDetailClient({ jobId }: { jobId: string }) {
  // The outcome is remembered with the jobId it answers; an outcome for another jobId counts as still loading, so a
  // changed jobId never shows the previous match (and needs no synchronous reset inside the effect).
  const [loaded, setLoaded] = useState<{ jobId: string; outcome: Outcome } | null>(null);
  const state: State = loaded !== null && loaded.jobId === jobId ? loaded.outcome : { kind: "loading" };

  useEffect(() => {
    let cancelled = false;
    const finish = (outcome: Outcome) => {
      if (!cancelled) setLoaded({ jobId, outcome });
    };
    fetch(`/api/matches/${encodeURIComponent(jobId)}`)
      .then(async (res) => {
        if (res.status === 404) return finish({ kind: "missing" });
        if (!res.ok) return finish({ kind: "error" });
        const body = await res.json();
        if (body && typeof body.job === "object" && typeof body.match === "object") {
          finish({
            kind: "ready",
            job: body.job,
            match: body.match,
            applicationId: typeof body.applicationId === "string" ? body.applicationId : null,
            model: typeof body.model?.decided === "number" && typeof body.model?.responses === "number"
              ? { decided: body.model.decided, responses: body.model.responses }
              : null,
          });
        } else {
          finish({ kind: "error" });
        }
      })
      .catch(() => finish({ kind: "error" }));
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const back = <Link href="/matches" className="text-sm underline">← All matches</Link>;

  if (state.kind === "loading") return <p>Loading...</p>;
  if (state.kind === "missing") return <div className="flex flex-col gap-3"><p>Match not found.</p>{back}</div>;
  if (state.kind === "error") return <div className="flex flex-col gap-3"><p role="alert" className="text-red-600">Could not load this match.</p>{back}</div>;

  const { job, match } = state;
  // An applied job becomes ineligible on the next matching run ("already applied"); its documents must stay viewable.
  const showWorkspace = match.eligible || state.applicationId !== null;

  return (
    <div className="flex flex-col gap-6">
      {back}
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{job.title}</h1>
          <p className="text-sm text-gray-600">{job.companyName} · {job.locationRaw ?? "Location unknown"} · {job.workMode}</p>
        </div>
        {match.eligible && match.overallScore !== null && (
          <span className="shrink-0 rounded bg-black px-3 py-1.5 text-lg font-semibold text-white">{match.overallScore}/100</span>
        )}
      </header>

      {!match.eligible && match.ineligibleReason && (
        <p className="rounded border p-4 text-sm">{match.ineligibleReason}</p>
      )}

      {match.eligible && match.factors && (
        <section aria-labelledby="factors-heading">
          <h2 id="factors-heading" className="mb-2 font-medium">Match factors</h2>
          <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
            {FACTOR_LABELS.map(([key, label]) => (
              <div key={key} className="contents">
                <dt className="text-gray-600">{label}</dt>
                <dd>{match.factors![key] === null ? "Not comparable" : `${match.factors![key]}%`}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {match.eligible && match.personal && (
        <section aria-labelledby="history-heading" className="flex flex-col gap-1 text-sm">
          <h2 id="history-heading" className="font-medium">Your history</h2>
          <p>{`Your history: ${formatLikelyResponse(match.personal)}`}</p>
          {formatFactorPushes(match.personal) && <p>{formatFactorPushes(match.personal)}</p>}
          {state.model && <p>{formatSampleSize(state.model)}</p>}
          <p className="text-xs text-gray-600">
            Based on how these factors have gone with responses in your own applications — not a cause or a guarantee.
          </p>
        </section>
      )}

      {match.eligible && match.explanation && (
        <section aria-labelledby="explanation-heading">
          <h2 id="explanation-heading" className="mb-2 font-medium">Why this match</h2>
          <p className="mb-3 text-sm">{match.explanation.summary}</p>
          {match.explanation.strongMatches.length > 0 && (
            <div className="mb-2">
              <h3 className="text-sm font-medium text-green-700">Strong matches</h3>
              <ul className="list-disc pl-5 text-sm">{match.explanation.strongMatches.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
          {match.explanation.partialMatches.length > 0 && (
            <div className="mb-2">
              <h3 className="text-sm font-medium text-yellow-700">Partial matches</h3>
              <ul className="list-disc pl-5 text-sm">{match.explanation.partialMatches.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
          {match.explanation.gaps.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-red-700">Gaps</h3>
              <ul className="list-disc pl-5 text-sm">{match.explanation.gaps.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
        </section>
      )}

      <ApplicationPanel jobId={jobId} />
      {showWorkspace && <AutofillPanel jobId={jobId} />}
      {showWorkspace && <SkillGapsPanel jobId={jobId} />}
      {showWorkspace && <ResumeOptimizationPanel jobId={jobId} />}
      {showWorkspace && <PitchPanel jobId={jobId} />}
      {showWorkspace && <CoverLetterPanel jobId={jobId} />}
      {showWorkspace && <InterviewPrepPanel jobId={jobId} />}
      {showWorkspace && <DocumentsList jobId={jobId} />}

      <section aria-labelledby="description-heading">
        <h2 id="description-heading" className="mb-2 font-medium">Job description</h2>
        <p className="whitespace-pre-wrap text-sm text-gray-700">{job.descriptionText}</p>
      </section>
    </div>
  );
}
