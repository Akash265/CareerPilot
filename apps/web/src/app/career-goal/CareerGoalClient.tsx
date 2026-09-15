"use client";

import { useEffect, useState } from "react";
import { GoalForm, type ParsedGoal } from "./GoalForm";
import { GoalReviewForm } from "./GoalReviewForm";
import { GoalDashboard, type ActiveGoal, type GoalHistoryEntry } from "./GoalDashboard";

type Stage = "loading" | "form" | "reviewing" | "dashboard" | "error";

export function CareerGoalClient() {
  const [stage, setStage] = useState<Stage>("loading");
  const [activeGoal, setActiveGoal] = useState<ActiveGoal | null>(null);
  const [history, setHistory] = useState<GoalHistoryEntry[]>([]);
  const [prefillRawText, setPrefillRawText] = useState("");
  const [reviewing, setReviewing] = useState<ParsedGoal | null>(null);

  function loadState() {
    return fetch("/api/career-goal")
      .then((res) => {
        if (!res.ok) throw new Error(`GET /api/career-goal failed: ${res.status}`);
        return res.json();
      })
      .then((body) => {
        setActiveGoal(body.activeGoal);
        setHistory(body.history);
        setStage(body.activeGoal ? "dashboard" : "form");
      })
      .catch(() => setStage("error"));
  }

  useEffect(() => {
    loadState();
  }, []);

  if (stage === "loading") return <p>Loading...</p>;
  if (stage === "error") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-red-600">
          Could not load your career goal — check your connection and try again.
        </p>
        <button
          type="button"
          onClick={() => {
            setStage("loading");
            loadState();
          }}
          className="w-fit rounded border px-4 py-2 text-sm"
        >
          Retry
        </button>
      </div>
    );
  }
  if (stage === "dashboard" && activeGoal) {
    return (
      <GoalDashboard
        activeGoal={activeGoal}
        history={history}
        onEdit={() => {
          setPrefillRawText(activeGoal.rawText);
          setStage("form");
        }}
      />
    );
  }
  if (stage === "reviewing" && reviewing) {
    return (
      <GoalReviewForm
        goalId={reviewing.goalId}
        version={reviewing.version}
        rawText={reviewing.rawText}
        initialDraft={reviewing.draft}
        onConfirmed={() => loadState()}
      />
    );
  }
  return (
    <GoalForm
      initialRawText={prefillRawText}
      onParsed={(result) => {
        setReviewing(result);
        setStage("reviewing");
      }}
    />
  );
}
