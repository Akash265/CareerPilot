import type { WorkMode, WorkModePreference } from "../types";

/**
 * The hard remote-vs-onsite/hybrid mismatch is already excluded before scoring (Task 1); everything
 * reaching this function is a *softer* signal about work mode and geography.
 */
export function scoreLocation(
  jobWorkMode: WorkMode,
  constraintsWorkMode: WorkModePreference,
  jobLocationRaw: string | null,
  jobCountryCode: string | null,
  goalLocations: string[]
): number {
  if (constraintsWorkMode === "any") return 1;
  if (jobWorkMode === constraintsWorkMode) return 1;
  if (jobWorkMode === "unknown") return 0.5;

  if (goalLocations.length === 0) return 0.6;
  const haystack = `${jobLocationRaw ?? ""} ${jobCountryCode ?? ""}`.toLowerCase();
  const overlaps = goalLocations.some((loc) => haystack.includes(loc.toLowerCase()));
  return overlaps ? 0.7 : 0.3;
}
