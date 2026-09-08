"use client";

import { useEffect, useState } from "react";
import { UploadForm } from "./UploadForm";
import { ReviewForm, toEditableProfile, createBlankProfile, type EditableProfile } from "./ReviewForm";
import { ProfileDashboard } from "./ProfileDashboard";

type Stage = "loading" | "upload" | "reviewing" | "dashboard" | "error";

export function ProfileClient() {
  const [stage, setStage] = useState<Stage>("loading");
  const [editableProfile, setEditableProfile] = useState<EditableProfile | null>(null);

  function loadProfile() {
    return fetch("/api/profile")
      .then((res) => {
        // A non-2xx response (e.g. a 500) must not be read as "no profile
        // yet" just because its body happens to parse as JSON with no
        // `profile` field -- that would silently drop the user onto the
        // upload form instead of surfacing the real failure.
        if (!res.ok) throw new Error(`GET /api/profile failed: ${res.status}`);
        return res.json();
      })
      .then((body) => {
        setEditableProfile(body.profile);
        setStage(body.profile ? "dashboard" : "upload");
      })
      .catch(() => setStage("error"));
  }

  useEffect(() => {
    loadProfile();
  }, []);

  if (stage === "loading") return <p>Loading...</p>;
  if (stage === "error") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-red-600">
          Could not load your profile — check your connection and try again.
        </p>
        <button
          type="button"
          onClick={() => {
            setStage("loading");
            loadProfile();
          }}
          className="w-fit rounded border px-4 py-2 text-sm"
        >
          Retry
        </button>
      </div>
    );
  }
  if (stage === "dashboard" && editableProfile) {
    return (
      <ProfileDashboard
        profile={editableProfile}
        onEdit={() => setStage("reviewing")}
      />
    );
  }
  if (stage === "reviewing" && editableProfile) {
    return (
      <ReviewForm
        initialProfile={editableProfile}
        onSaved={() => loadProfile()}
      />
    );
  }
  return (
    <UploadForm
      onExtracted={(extracted) => {
        setEditableProfile(toEditableProfile(extracted));
        setStage("reviewing");
      }}
      onStartBlank={() => {
        setEditableProfile(createBlankProfile());
        setStage("reviewing");
      }}
    />
  );
}
