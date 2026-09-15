"use client";

import { useState } from "react";

export type CareerGoalConstraintsDraft = {
  targetRoles: string[];
  seniority: string | null;
  locations: string[];
  workMode: "remote" | "hybrid" | "onsite" | "any";
  minExperienceYears: number | null;
  employmentType: string | null;
  salaryFloorRaw: string | null;
  salaryFloorNormalized: number | null;
  salaryCurrency: string | null;
  salaryIsParsed: boolean;
  visaSponsorshipRequired: boolean | null;
  skills: string[];
  preferredIndustries: string[];
  excludedIndustries: string[];
  preferredCompanies: string[];
  excludedCompanies: string[];
  hardConstraints: string[];
};

const orNull = (value: string): string | null => (value.trim() === "" ? null : value);
const orNullNumber = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
};
const fromCommaList = (value: string): string[] => value.split(",").map((part) => part.trim());
const toCommaList = (values: string[]): string => values.join(", ");
const nonEmpty = (values: string[]): string[] => values.filter((value) => value.trim() !== "");

export function toConstraintsPayload(draft: CareerGoalConstraintsDraft): CareerGoalConstraintsDraft {
  return {
    ...draft,
    targetRoles: nonEmpty(draft.targetRoles),
    locations: nonEmpty(draft.locations),
    skills: nonEmpty(draft.skills),
    preferredIndustries: nonEmpty(draft.preferredIndustries),
    excludedIndustries: nonEmpty(draft.excludedIndustries),
    preferredCompanies: nonEmpty(draft.preferredCompanies),
    excludedCompanies: nonEmpty(draft.excludedCompanies),
    hardConstraints: nonEmpty(draft.hardConstraints),
  };
}

function TristateSelect({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value === null ? "unspecified" : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "unspecified" ? null : v === "true");
        }}
        className="block w-full rounded border px-2 py-1"
      >
        <option value="unspecified">Not specified</option>
        <option value="true">Required</option>
        <option value="false">Not required</option>
      </select>
    </div>
  );
}

export function GoalReviewForm({
  goalId,
  version,
  rawText,
  initialDraft,
  onConfirmed,
}: {
  goalId: string;
  version: number;
  rawText: string;
  initialDraft: CareerGoalConstraintsDraft;
  onConfirmed: () => void;
}) {
  const [draft, setDraft] = useState<CareerGoalConstraintsDraft>(initialDraft);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function setField<K extends keyof CareerGoalConstraintsDraft>(
    key: K,
    value: CareerGoalConstraintsDraft[K]
  ) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function handleConfirm() {
    setIsSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/career-goal/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId, constraints: toConstraintsPayload(draft) }),
      });
      const body = await res.json();
      if (body.status === "confirmed") {
        onConfirmed();
      } else {
        setSaveError(body.error ?? "Save failed — please try again.");
      }
    } catch {
      setSaveError("Could not reach the server — check your connection and try again.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded border bg-gray-50 p-3">
        <h3 className="text-sm font-semibold">Version {version} — your original statement</h3>
        <p className="text-sm text-gray-700">{rawText}</p>
      </div>

      <div>
        <label htmlFor="target-roles" className="text-sm font-medium">
          Target roles (comma separated)
        </label>
        <input
          id="target-roles"
          value={toCommaList(draft.targetRoles)}
          onChange={(e) => setField("targetRoles", fromCommaList(e.target.value))}
          className="block w-full rounded border px-2 py-1"
        />
      </div>

      <div>
        <label htmlFor="seniority" className="text-sm font-medium">
          Seniority
        </label>
        <input
          id="seniority"
          value={draft.seniority ?? ""}
          onChange={(e) => setField("seniority", orNull(e.target.value))}
          className="block w-full rounded border px-2 py-1"
        />
      </div>

      <div>
        <label htmlFor="locations" className="text-sm font-medium">
          Locations (comma separated)
        </label>
        <input
          id="locations"
          value={toCommaList(draft.locations)}
          onChange={(e) => setField("locations", fromCommaList(e.target.value))}
          className="block w-full rounded border px-2 py-1"
        />
      </div>

      <div>
        <label htmlFor="work-mode" className="text-sm font-medium">
          Work mode
        </label>
        <select
          id="work-mode"
          value={draft.workMode}
          onChange={(e) => setField("workMode", e.target.value as CareerGoalConstraintsDraft["workMode"])}
          className="block w-full rounded border px-2 py-1"
        >
          <option value="remote">remote</option>
          <option value="hybrid">hybrid</option>
          <option value="onsite">onsite</option>
          <option value="any">any</option>
        </select>
      </div>

      <div>
        <label htmlFor="min-experience-years" className="text-sm font-medium">
          Minimum experience (years)
        </label>
        <input
          id="min-experience-years"
          type="number"
          value={draft.minExperienceYears === null ? "" : String(draft.minExperienceYears)}
          onChange={(e) => setField("minExperienceYears", orNullNumber(e.target.value))}
          className="block w-full rounded border px-2 py-1"
        />
      </div>

      <div>
        <label htmlFor="employment-type" className="text-sm font-medium">
          Employment type
        </label>
        <input
          id="employment-type"
          value={draft.employmentType ?? ""}
          onChange={(e) => setField("employmentType", orNull(e.target.value))}
          className="block w-full rounded border px-2 py-1"
        />
      </div>

      <div className="rounded border p-3">
        <p className="text-sm font-medium">Salary floor</p>
        {!draft.salaryIsParsed && draft.salaryFloorRaw && (
          <p className="text-sm text-amber-700">
            Could not confidently read a number from &quot;{draft.salaryFloorRaw}&quot; — please confirm it below.
          </p>
        )}
        <label htmlFor="salary-floor-amount" className="text-sm font-medium">
          Amount
        </label>
        <input
          id="salary-floor-amount"
          type="number"
          value={draft.salaryFloorNormalized === null ? "" : String(draft.salaryFloorNormalized)}
          onChange={(e) => {
            const amount = orNullNumber(e.target.value);
            setDraft((d) => ({
              ...d,
              salaryFloorNormalized: amount,
              salaryIsParsed: amount !== null && d.salaryCurrency !== null,
            }));
          }}
          className="block w-full rounded border px-2 py-1"
        />
        <label htmlFor="salary-currency" className="text-sm font-medium">
          Currency
        </label>
        <input
          id="salary-currency"
          value={draft.salaryCurrency ?? ""}
          onChange={(e) => {
            const currency = orNull(e.target.value);
            setDraft((d) => ({
              ...d,
              salaryCurrency: currency,
              salaryIsParsed: currency !== null && d.salaryFloorNormalized !== null,
            }));
          }}
          className="block w-full rounded border px-2 py-1"
        />
      </div>

      <TristateSelect
        id="visa-sponsorship-required"
        label="Visa sponsorship"
        value={draft.visaSponsorshipRequired}
        onChange={(v) => setField("visaSponsorshipRequired", v)}
      />

      <div>
        <label htmlFor="skills" className="text-sm font-medium">
          Priority skills (comma separated)
        </label>
        <input
          id="skills"
          value={toCommaList(draft.skills)}
          onChange={(e) => setField("skills", fromCommaList(e.target.value))}
          className="block w-full rounded border px-2 py-1"
        />
      </div>

      <div>
        <label htmlFor="preferred-industries" className="text-sm font-medium">
          Preferred industries (comma separated)
        </label>
        <input
          id="preferred-industries"
          value={toCommaList(draft.preferredIndustries)}
          onChange={(e) => setField("preferredIndustries", fromCommaList(e.target.value))}
          className="block w-full rounded border px-2 py-1"
        />
      </div>

      <div>
        <label htmlFor="excluded-industries" className="text-sm font-medium">
          Excluded industries (comma separated)
        </label>
        <input
          id="excluded-industries"
          value={toCommaList(draft.excludedIndustries)}
          onChange={(e) => setField("excludedIndustries", fromCommaList(e.target.value))}
          className="block w-full rounded border px-2 py-1"
        />
      </div>

      <div>
        <label htmlFor="preferred-companies" className="text-sm font-medium">
          Preferred companies (comma separated)
        </label>
        <input
          id="preferred-companies"
          value={toCommaList(draft.preferredCompanies)}
          onChange={(e) => setField("preferredCompanies", fromCommaList(e.target.value))}
          className="block w-full rounded border px-2 py-1"
        />
      </div>

      <div>
        <label htmlFor="excluded-companies" className="text-sm font-medium">
          Excluded companies (comma separated)
        </label>
        <input
          id="excluded-companies"
          value={toCommaList(draft.excludedCompanies)}
          onChange={(e) => setField("excludedCompanies", fromCommaList(e.target.value))}
          className="block w-full rounded border px-2 py-1"
        />
      </div>

      <div>
        <label htmlFor="hard-constraints" className="text-sm font-medium">
          Other must-haves (comma separated)
        </label>
        <input
          id="hard-constraints"
          value={toCommaList(draft.hardConstraints)}
          onChange={(e) => setField("hardConstraints", fromCommaList(e.target.value))}
          className="block w-full rounded border px-2 py-1"
        />
      </div>

      {saveError && <p className="text-sm text-red-600">{saveError}</p>}
      <button
        type="button"
        onClick={handleConfirm}
        disabled={isSaving}
        className="w-fit rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {isSaving ? "Saving..." : "Confirm & Save"}
      </button>
    </div>
  );
}
