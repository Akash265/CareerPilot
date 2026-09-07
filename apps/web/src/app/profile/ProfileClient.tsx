"use client";

import { useState } from "react";
import { UploadForm } from "./UploadForm";
import { ReviewForm, toEditableProfile, type EditableProfile } from "./ReviewForm";

type Stage = "upload" | "reviewing" | "saved";

export function ProfileClient() {
  const [stage, setStage] = useState<Stage>("upload");
  const [editableProfile, setEditableProfile] = useState<EditableProfile | null>(null);

  if (stage === "reviewing" && editableProfile) {
    return <ReviewForm initialProfile={editableProfile} onSaved={() => setStage("saved")} />;
  }
  if (stage === "saved") {
    return <p>Profile saved.</p>;
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
