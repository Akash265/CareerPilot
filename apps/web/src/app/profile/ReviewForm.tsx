"use client";

import { useState } from "react";
import type { ResumeExtractionDraft } from "@ai-career/ai";

export type EditableProfile = ResumeExtractionDraft & {
  yearsOfExperience: number | null;
  workModePreference: "remote" | "hybrid" | "onsite" | "any";
  salaryExpectationMin: number | null;
  salaryExpectationMax: number | null;
  salaryCurrency: string | null;
  visaSponsorshipRequired: boolean;
  workAuthorizationNotes: string | null;
  preferredRoleTitles: string[];
  preferredIndustries: string[];
  excludedIndustries: string[];
  preferredCompanies: string[];
  excludedCompanies: string[];
};

export function toEditableProfile(draft: ResumeExtractionDraft): EditableProfile {
  return {
    ...draft,
    yearsOfExperience: null,
    workModePreference: "any",
    salaryExpectationMin: null,
    salaryExpectationMax: null,
    salaryCurrency: null,
    visaSponsorshipRequired: false,
    workAuthorizationNotes: null,
    preferredRoleTitles: [],
    preferredIndustries: [],
    excludedIndustries: [],
    preferredCompanies: [],
    excludedCompanies: [],
  };
}

export function ReviewForm({
  initialProfile,
  onSaved,
}: {
  initialProfile: EditableProfile;
  onSaved: () => void;
}) {
  const [profile, setProfile] = useState<EditableProfile>(initialProfile);
  const [isSaving, setIsSaving] = useState(false);

  async function handleConfirm() {
    setIsSaving(true);
    try {
      const res = await fetch("/api/profile/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      const body = await res.json();
      if (body.status === "saved") {
        onSaved();
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor="full-name" className="text-sm font-medium">Full name</label>
        <input
          id="full-name"
          value={profile.contact.fullName}
          onChange={(e) =>
            setProfile((p) => ({ ...p, contact: { ...p.contact, fullName: e.target.value } }))
          }
          className="block w-full rounded border px-2 py-1"
        />
      </div>
      <div>
        <h3 className="text-sm font-medium">Skills</h3>
        <ul className="list-disc pl-5 text-sm">
          {profile.skills.map((skill, i) => (
            <li key={i}>{skill.name}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={handleConfirm}
        disabled={isSaving}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {isSaving ? "Saving..." : "Confirm & Save"}
      </button>
    </div>
  );
}
