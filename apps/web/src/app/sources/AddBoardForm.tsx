"use client";

import { useState } from "react";

export function AddBoardForm({ onAdded }: { onAdded: () => void }) {
  const [kind, setKind] = useState<"greenhouse" | "lever">("greenhouse");
  const [slug, setSlug] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (slug.trim() === "") {
      setError("Enter the board token.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/job-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, slug: slug.trim(), ...(companyName.trim() ? { companyName: companyName.trim() } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Could not add that board.");
        return;
      }
      setSlug("");
      setCompanyName("");
      onAdded();
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded border p-4">
      <legend className="px-1 text-sm font-medium">Add a company board</legend>
      <label htmlFor="board-kind" className="text-sm">Source type</label>
      <select id="board-kind" value={kind} onChange={(e) => setKind(e.target.value as "greenhouse" | "lever")} className="block rounded border px-2 py-1">
        <option value="greenhouse">Greenhouse</option>
        <option value="lever">Lever</option>
      </select>
      <label htmlFor="board-slug" className="text-sm">Board token</label>
      <input id="board-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="e.g. gitlab" className="block rounded border px-2 py-1" />
      <p className="text-xs text-gray-500">The last part of the company&apos;s job-board address, e.g. boards.greenhouse.io/<b>gitlab</b> or jobs.lever.co/<b>spotify</b>.</p>
      <label htmlFor="board-company" className="text-sm">Company name (optional)</label>
      <input id="board-company" value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="block rounded border px-2 py-1" />
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button type="button" onClick={submit} disabled={busy} className="w-fit rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {busy ? "Adding..." : "Add board"}
      </button>
    </fieldset>
  );
}
