"use client";

import { useState } from "react";

export function UploadJobsForm({ onUploaded }: { onUploaded: (message: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!file) {
      setError("Select a file first.");
      return;
    }
    if (!consent) {
      setError("Confirm that you are permitted to use this data.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("consentConfirmed", "true");
      const res = await fetch("/api/job-sources/upload", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Could not upload that file.");
        return;
      }
      setFile(null);
      setConsent(false);
      onUploaded(
        body.queued
          ? `Uploaded ${body.count} jobs — they are being processed.`
          : `Uploaded ${body.count} jobs, but the worker queue is unavailable. Use “Run now” once it is running.`
      );
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded border p-4">
      <legend className="px-1 text-sm font-medium">Upload a job export</legend>
      <label htmlFor="upload-file" className="text-sm">Job file (CSV or JSON)</label>
      <input id="upload-file" type="file" accept=".csv,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block text-sm" />
      <p className="text-xs text-gray-500">Columns: <b>title</b> and <b>company</b> are required; location, description, url, posted_at, employment_type, salary and id are optional. Up to 5,000 rows.</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
        I confirm I am permitted to use the data in this file.
      </label>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button type="button" onClick={submit} disabled={busy} className="w-fit rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {busy ? "Uploading..." : "Upload"}
      </button>
    </fieldset>
  );
}
