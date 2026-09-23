import Link from "next/link";
import type { MatchListItem } from "../../lib/matching/listMatches";

const FACTOR_LABELS: [key: keyof NonNullable<MatchListItem["match"]["factors"]>, label: string][] = [
  ["skills", "Skills"], ["experience", "Experience"], ["location", "Location"], ["sponsorship", "Sponsorship"],
  ["role", "Role"], ["salary", "Salary"], ["industry", "Industry"], ["freshness", "Freshness"], ["semantic", "Fit"],
];

export function MatchRow({
  item, busy, onSave, onDismiss,
}: {
  item: MatchListItem;
  busy: boolean;
  onSave: () => void;
  onDismiss: () => void;
}) {
  const { match } = item;
  return (
    <li className="flex flex-col gap-2 rounded border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href={`/matches/${item.jobId}`} className="font-medium underline">{item.jobTitle}</Link>
          <p className="text-sm text-gray-600">{item.companyName} · {item.locationRaw ?? "Location unknown"} · {item.workMode}</p>
        </div>
        {match.overallScore !== null && (
          <span className="shrink-0 rounded bg-black px-2 py-1 text-sm font-semibold text-white">{match.overallScore}/100</span>
        )}
      </div>

      {!match.eligible && match.ineligibleReason && (
        <p className="text-sm text-gray-600">{match.ineligibleReason}</p>
      )}

      {match.eligible && match.factors && (
        <ul className="flex flex-wrap gap-2 text-xs" aria-label="Match factors">
          {FACTOR_LABELS.map(([key, label]) => {
            const value = match.factors![key];
            return (
              <li key={key} className="rounded-full border px-2 py-0.5">
                {label}: {value === null ? "n/a" : `${value}%`}
              </li>
            );
          })}
        </ul>
      )}

      {match.eligible && match.explanation?.summary && <p className="text-sm">{match.explanation.summary}</p>}

      {match.eligible && (
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={onSave} className="rounded border px-3 py-1 text-sm disabled:opacity-50">
            {match.userAction === "saved" ? "Saved" : "Save"}
          </button>
          <button type="button" disabled={busy} onClick={onDismiss} className="rounded border px-3 py-1 text-sm disabled:opacity-50">
            {match.userAction === "dismissed" ? "Dismissed" : "Dismiss"}
          </button>
        </div>
      )}
    </li>
  );
}
