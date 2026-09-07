import { createHash } from "node:crypto";

export type ProfileFactSourceType =
  | "education" | "work_experience_bullet" | "skill" | "project" | "certification" | "achievement";

export interface DerivedFact {
  sourceType: ProfileFactSourceType;
  sourceId: string;
  factText: string;
  contentHash: string;
}

export function deriveFact(sourceType: ProfileFactSourceType, sourceId: string, factText: string): DerivedFact {
  return { sourceType, sourceId, factText, contentHash: createHash("sha256").update(factText).digest("hex") };
}
