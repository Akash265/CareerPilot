"use client";

import { useEffect, useState } from "react";
import { DOCUMENTS_CHANGED_EVENT } from "./DownloadButtons";
import { tailoredSummary, type TailoredDetailsView } from "./TailoredResumeExport";

interface DocumentView {
  id: string;
  kind: "resume" | "pitch" | "cover_letter" | "interview_prep" | "tailored_resume";
  format: "pdf" | "docx" | "tex";
  sourceVersion: number | null;
  downloadFilename: string;
  byteSize: number;
  createdAt: string;
  downloadUrl: string;
  details?: TailoredDetailsView | null;
}

const KIND_LABELS: Record<DocumentView["kind"], string> = {
  resume: "Resume",
  pitch: "Pitch",
  cover_letter: "Cover letter",
  interview_prep: "Interview prep",
  tailored_resume: "Tailored resume (LaTeX)",
};

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; documents: DocumentView[] };

export function DocumentsList({
  jobId,
  navigate = (url: string) => window.location.assign(url),
}: {
  jobId: string;
  navigate?: (url: string) => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    // Promise chain (state set in callbacks), matching the other panels' react-hooks/set-state-in-effect pattern.
    const load = () =>
      fetch(`/api/documents?jobId=${encodeURIComponent(jobId)}`)
        .then((res) => {
          if (!res.ok) throw new Error("load failed");
          return res.json();
        })
        .then((body) => {
          if (!ignore) setState({ kind: "ready", documents: body.documents as DocumentView[] });
        })
        .catch(() => {
          if (!ignore) setState({ kind: "error" });
        });
    load();
    window.addEventListener(DOCUMENTS_CHANGED_EVENT, load);
    return () => {
      ignore = true;
      window.removeEventListener(DOCUMENTS_CHANGED_EVENT, load);
    };
  }, [jobId]);

  // Preflight with HEAD before navigating: a download link that 404s/502s would otherwise navigate the
  // whole app to a raw JSON error page instead of showing an inline error (second review, fix round 2).
  const handleDownload = async (url: string) => {
    setDownloadError(null);
    try {
      const head = await fetch(url, { method: "HEAD" });
      if (!head.ok) {
        setDownloadError("Could not download the document. Try again.");
        return;
      }
      navigate(url);
    } catch {
      setDownloadError("Could not download the document. Try again.");
    }
  };

  return (
    <section aria-labelledby="documents-heading" className="flex flex-col gap-2">
      <h2 id="documents-heading" className="font-medium">Documents</h2>
      {state.kind === "loading" && <p className="text-sm text-gray-600">Loading documents...</p>}
      {state.kind === "error" && <p role="alert" className="text-sm text-red-600">Could not load documents.</p>}
      {state.kind === "ready" && state.documents.length === 0 && (
        <p className="text-sm text-gray-600">No documents exported yet.</p>
      )}
      {state.kind === "ready" && state.documents.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {state.documents.map((d) => (
            <li key={d.id}>
              {KIND_LABELS[d.kind]} v{d.sourceVersion ?? "?"} · {d.format.toUpperCase()} ·{" "}
              {d.details ? `${tailoredSummary(d.details)} · ` : ""}
              {new Date(d.createdAt).toLocaleString()} ·{" "}
              <button type="button" className="underline" onClick={() => handleDownload(d.downloadUrl)}>Download</button>
            </li>
          ))}
        </ul>
      )}
      {downloadError && <p role="alert" className="text-sm text-red-600">{downloadError}</p>}
    </section>
  );
}
