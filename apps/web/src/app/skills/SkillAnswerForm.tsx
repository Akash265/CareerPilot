"use client";

import { useState } from "react";

/** Dispatched on window after every answer or undo, so other panels on the page (resume notice, job panel) reload. */
export const SKILL_GAPS_CHANGED_EVENT = "skill-gaps-changed";
const MAX_EVIDENCE = 300;

type Mode = "idle" | "have" | "alias";

/** Phase 13b design §7: the three answers to "this job requires <term>". "I have it" needs one evidence sentence. */
export function SkillAnswerForm({ termDisplay, suggestion, profileSkills, onSaved }: {
  termDisplay: string; suggestion: string | null; profileSkills: string[]; onSaved: () => void;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [evidence, setEvidence] = useState("");
  const [alias, setAlias] = useState(suggestion && profileSkills.includes(suggestion) ? suggestion : (profileSkills[0] ?? ""));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (body: Record<string, string>) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/skill-verifications", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ termDisplay, ...body }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setError(payload?.error ?? "Could not save your answer.");
        return;
      }
      window.dispatchEvent(new Event(SKILL_GAPS_CHANGED_EVENT));
      onSaved();
    } catch {
      setError("Could not save your answer.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" onClick={() => setMode("have")} disabled={saving} className="rounded border px-2 py-1">I have it</button>
        <button type="button" onClick={() => save({ status: "dont_have" })} disabled={saving} className="rounded border px-2 py-1">I don&apos;t have it</button>
        <button type="button" onClick={() => setMode("alias")} disabled={saving || profileSkills.length === 0} className="rounded border px-2 py-1">Same as…</button>
        {suggestion && <span className="text-gray-600">Suggested: {suggestion}</span>}
      </div>
      {mode === "have" && (
        <div className="flex flex-col gap-1">
          <label className="text-sm" htmlFor={`evidence-${termDisplay}`}>Where you used {termDisplay}</label>
          <textarea
            id={`evidence-${termDisplay}`}
            value={evidence}
            maxLength={MAX_EVIDENCE}
            onChange={(e) => setEvidence(e.target.value)}
            className="rounded border p-2 text-sm"
            rows={2}
          />
          <span className="text-xs text-gray-500">{evidence.length}/{MAX_EVIDENCE}</span>
          <button type="button" onClick={() => save({ status: "have", evidence })} disabled={saving || evidence.trim().length === 0}
            className="self-start rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50">Save</button>
        </div>
      )}
      {mode === "alias" && (
        <div className="flex items-center gap-2">
          <label className="text-sm" htmlFor={`alias-${termDisplay}`}>Same as which of your skills</label>
          <select id={`alias-${termDisplay}`} value={alias} onChange={(e) => setAlias(e.target.value)} className="rounded border p-1 text-sm">
            {profileSkills.map((name) => <option key={name} value={name}>{name}{name === suggestion ? " (suggested)" : ""}</option>)}
          </select>
          <button type="button" onClick={() => save({ status: "alias", aliasSkillName: alias })} disabled={saving || !alias}
            className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50">Save</button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
