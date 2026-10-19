import type { DocumentBlock } from "./types";
import { certDates, dateRange, present, type ResumeProfile } from "./resumeProfile";

/** Joins the non-blank parts with " · ", or null if none are present. */
export function joinPresent(parts: (string | null)[]): string | null {
  const kept = parts.filter(present);
  return kept.length > 0 ? kept.join(" · ") : null;
}

/** Education, verbatim (records are never reworded, D82). Shared by the full and the tailored resume. */
export function educationBlocks(profile: ResumeProfile): DocumentBlock[] {
  if (profile.education.length === 0) return [];
  return [
    { type: "heading", text: "Education" },
    ...profile.education.map((e): DocumentBlock => ({
      type: "entry",
      title: present(e.fieldOfStudy) ? `${e.degree} in ${e.fieldOfStudy}` : e.degree,
      subtitle: present(e.gpa) ? `${e.institution} · GPA ${e.gpa}` : e.institution,
      meta: dateRange(e.startDate, e.endDate),
    })),
  ];
}

export function certificationBlocks(profile: ResumeProfile): DocumentBlock[] {
  if (profile.certifications.length === 0) return [];
  return [
    { type: "heading", text: "Certifications" },
    ...profile.certifications.map((c): DocumentBlock => ({ type: "entry", title: c.name, subtitle: c.issuer, meta: certDates(c.issueDate, c.expiryDate) })),
  ];
}
