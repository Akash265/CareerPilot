"use client";

import { useState } from "react";
import type { ResumeExtractionDraft } from "@ai-career/ai";

export function UploadForm({ onExtracted }: { onExtracted: (draft: ResumeExtractionDraft) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function handleUpload() {
    if (!file) {
      setError("Please select a file to upload.");
      return;
    }
    setError(null);
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/profile/resume", { method: "POST", body: formData });
      const body = await res.json();
      if (body.status === "extracted") {
        onExtracted(body.draft);
      } else {
        setError(body.error ?? "Extraction failed — please fill in your profile manually.");
      }
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="resume-file" className="text-sm font-medium">
        Resume file (PDF, DOCX, or LaTeX)
      </label>
      <input
        id="resume-file"
        type="file"
        accept=".pdf,.docx,.tex"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        onClick={handleUpload}
        disabled={isUploading}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {isUploading ? "Uploading..." : "Upload"}
      </button>
    </div>
  );
}
