"use client";

import type { CareerGoalConstraintsDraft } from "./GoalReviewForm";

export type ActiveGoal = {
  id: string;
  version: number;
  rawText: string;
  confirmedAt: string | null;
  constraints: CareerGoalConstraintsDraft;
};

export type GoalHistoryEntry = {
  id: string;
  version: number;
  rawText: string;
  confirmedAt: string | null;
};

const EMPTY = "—";

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <p className="text-sm">
      <span className="font-medium">{label}: </span>
      <span>{value === null || value === "" ? EMPTY : value}</span>
    </p>
  );
}

function List({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <h4 className="text-sm font-medium">{label}</h4>
      {values.length === 0 ? (
        <p className="text-sm text-gray-500">{EMPTY}</p>
      ) : (
        <ul className="list-disc pl-5 text-sm">
          {values.map((value, i) => (
            <li key={i}>{value}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The API returns an ISO timestamp; the UTC calendar date is enough here.
function formatDate(iso: string | null): string {
  return iso === null ? "date unknown" : iso.slice(0, 10);
}

// Shows the number the system will actually use next to the phrase it was read
// from, so a wrong conversion is visible on the dashboard, not only in review.
function salaryText(
  raw: string | null,
  amount: number | null,
  currency: string | null,
  isParsed: boolean
): string | null {
  if (amount === null) return raw === null ? null : `"${raw}" — no number recognised`;
  const figure = `${amount} ${currency ?? ""}`.trim() + (isParsed ? "" : " (unconfirmed)");
  return raw === null ? figure : `${figure} — from "${raw}"`;
}

function tristateLabel(value: boolean | null): string {
  if (value === null) return "Not specified";
  return value ? "Required" : "Not required";
}

export function GoalDashboard({
  activeGoal,
  history,
  onEdit,
}: {
  activeGoal: ActiveGoal;
  history: GoalHistoryEntry[];
  onEdit: () => void;
}) {
  const c = activeGoal.constraints;
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded border bg-gray-50 p-3">
        <h2 className="text-lg font-semibold">Version {activeGoal.version}</h2>
        <p className="text-xs text-gray-500">
          Confirmed {activeGoal.confirmedAt === null ? "(date unknown)" : formatDate(activeGoal.confirmedAt)}
        </p>
        <p className="text-sm text-gray-700">{activeGoal.rawText}</p>
      </div>

      <div className="flex flex-col gap-2">
        <List label="Target roles" values={c.targetRoles} />
        <Field label="Seniority" value={c.seniority} />
        <List label="Locations" values={c.locations} />
        <Field label="Work mode" value={c.workMode} />
        <Field
          label="Minimum experience (years)"
          value={c.minExperienceYears === null ? null : String(c.minExperienceYears)}
        />
        <Field label="Employment type" value={c.employmentType} />
        <Field
          label="Minimum salary"
          value={salaryText(c.salaryFloorRaw, c.salaryFloorNormalized, c.salaryCurrency, c.salaryIsParsed)}
        />
        <Field
          label="Preferred salary"
          value={salaryText(c.salaryTargetRaw, c.salaryTargetNormalized, c.salaryTargetCurrency, c.salaryTargetIsParsed)}
        />
        <Field label="Visa sponsorship" value={tristateLabel(c.visaSponsorshipRequired)} />
        <List label="Priority skills" values={c.skills} />
        <List label="Preferred industries" values={c.preferredIndustries} />
        <List label="Excluded industries" values={c.excludedIndustries} />
        <List label="Preferred companies" values={c.preferredCompanies} />
        <List label="Excluded companies" values={c.excludedCompanies} />
        <List label="Other must-haves" values={c.hardConstraints} />
      </div>

      {history.length > 1 && (
        <div>
          <h3 className="text-sm font-semibold">Version history</h3>
          <ul className="list-disc pl-5 text-sm">
            {history.map((entry) => (
              <li key={entry.id}>
                Version {entry.version} — {entry.rawText} (confirmed {formatDate(entry.confirmedAt)})
              </li>
            ))}
          </ul>
        </div>
      )}

      <button type="button" onClick={onEdit} className="w-fit rounded border px-4 py-2 text-sm">
        Edit Goal
      </button>
    </div>
  );
}
