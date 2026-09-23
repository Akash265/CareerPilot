import type { Sponsorship } from "../types";

/** The hard "required but not offered" mismatch is already excluded before scoring (Task 1). */
export function scoreSponsorship(required: boolean | null, jobSponsorship: Sponsorship): number {
  if (required !== true) return 1;
  if (jobSponsorship === "offered") return 1;
  if (jobSponsorship === "unknown") return 0.5;
  return 0;
}
