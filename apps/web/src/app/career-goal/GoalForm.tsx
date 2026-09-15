"use client";

import { useState } from "react";
import type { CareerGoalConstraintsDraft } from "./GoalReviewForm";

export type ParsedGoal = {
  goalId: string;
  version: number;
  rawText: string;
  draft: CareerGoalConstraintsDraft;
};

export function GoalForm({
  initialRawText = "",
  onParsed,
}: {
  initialRawText?: string;
  onParsed: (result: ParsedGoal) => void;
}) {
  const [rawText, setRawText] = useState(initialRawText);
  const [error, setError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);

  async function handleSubmit() {
    if (rawText.trim() === "") {
      setError("Please enter a career goal before continuing.");
      return;
    }
    setError(null);
    setIsParsing(true);
    try {
      const res = await fetch("/api/career-goal/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText }),
      });
      const body = await res.json();
      if (body.status === "parsed") {
        onParsed({ goalId: body.goalId, version: body.version, rawText: body.rawText, draft: body.draft });
      } else {
        setError(body.error ?? "Could not understand that goal statement — please try rephrasing it.");
      }
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setIsParsing(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="career-goal-text" className="text-sm font-medium">
        Describe the roles you&apos;re looking for
      </label>
      <textarea
        id="career-goal-text"
        value={rawText}
        onChange={(e) => setRawText(e.target.value)}
        placeholder="e.g. Data professional jobs in Germany or the UK, preferably fully remote, with visa sponsorship, and requiring at least 3 years of experience."
        className="block w-full rounded border px-2 py-1"
        rows={4}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={isParsing}
        className="w-fit rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {isParsing ? "Understanding..." : "Understand my goal"}
      </button>
    </div>
  );
}
