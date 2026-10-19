"use client";

import { useState } from "react";

export const DOCUMENTS_CHANGED_EVENT = "documents:changed";

type Format = "pdf" | "docx" | "tex";

export interface ExportBody {
  document: { downloadUrl: string; details?: { pageCount: number | null; pageVerified: boolean; includedCount: number; totalCount: number } | null };
  omittedItems?: { sourceType: string; text: string; reason: "no_requirement_match" | "page_limit" }[];
}

const DEFAULT_FORMATS: readonly Format[] = ["pdf", "docx"];

export function DownloadButtons({
  jobId,
  kind,
  sourceId,
  formats = DEFAULT_FORMATS,
  onExported,
  disabled = false,
  navigate = (url: string) => window.location.assign(url),
}: {
  jobId: string;
  kind: "resume" | "pitch" | "cover_letter" | "interview_prep" | "tailored_resume";
  sourceId: string;
  formats?: readonly Format[];
  onExported?: (body: ExportBody) => void;
  disabled?: boolean;
  navigate?: (url: string) => void;
}) {
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportAs = async (format: Format) => {
    setBusy(format);
    setError(null);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, jobId, sourceId, format }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not export the document.");
        return;
      }
      window.dispatchEvent(new Event(DOCUMENTS_CHANGED_EVENT));
      onExported?.(body as ExportBody);
      const downloadUrl = body.document.downloadUrl as string;
      // Preflight before navigating: a 404/502 JSON error response would otherwise navigate the whole app
      // to a raw JSON page instead of showing an inline error. Own try/catch: the export already succeeded
      // by this point, so a network error on the HEAD itself must not surface as "could not export".
      try {
        const head = await fetch(downloadUrl, { method: "HEAD" });
        if (!head.ok) {
          setError("Could not download the document. Try again.");
          return;
        }
      } catch {
        setError("Could not download the document. Try again.");
        return;
      }
      navigate(downloadUrl);
    } catch {
      setError("Could not export the document.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {formats.map((format) => (
          <button
            key={format}
            type="button"
            onClick={() => exportAs(format)}
            disabled={disabled || busy !== null}
            className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {busy === format ? "Exporting..." : `Download ${format === "tex" ? ".tex" : format.toUpperCase()}`}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
