"use client";

import { useEffect, useState } from "react";
import { UploadForm } from "./UploadForm";
import { ReviewForm, toEditableProfile, type EditableProfile } from "./ReviewForm";
import { ProfileDashboard } from "./ProfileDashboard";

type Stage = "loading" | "upload" | "reviewing" | "dashboard";

export function ProfileClient() {
  const [stage, setStage] = useState<Stage>("loading");
  const [editableProfile, setEditableProfile] = useState<EditableProfile | null>(null);

  function loadProfile() {
    return fetch("/api/profile")
      .then((res) => res.json())
      .then((body) => {
        setEditableProfile(body.profile);
        setStage(body.profile ? "dashboard" : "upload");
      });
  }

  useEffect(() => {
    loadProfile();
  }, []);

  if (stage === "loading") return <p>Loading...</p>;
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
    />
  );
}
