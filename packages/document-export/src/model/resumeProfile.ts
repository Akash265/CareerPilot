export interface ResumeContact {
  fullName: string;
  email: string;
  phoneNumber: string | null;
  linkedinUrl: string | null;
}

/** Everything a resume document may contain, each list already in display_order. No street address by design (D82). */
export interface ResumeProfile {
  contact: ResumeContact;
  experiences: {
    id: string;
    company: string;
    title: string;
    location: string | null;
    startDate: string | null;
    endDate: string | null;
    bullets: { id: string; text: string }[];
  }[];
  achievements: { id: string; description: string }[];
  projects: { id: string; name: string; description: string; url: string | null }[];
  certifications: { id: string; name: string; issuer: string; issueDate: string | null; expiryDate: string | null }[];
  education: {
    id: string;
    institution: string;
    degree: string;
    fieldOfStudy: string | null;
    startDate: string | null;
    endDate: string | null;
    gpa: string | null;
  }[];
  skills: { id: string; name: string }[];
  /** Phase 13b: skills the user verified (a "have" answer, or an alias to a skill still in the profile), as the job wrote them. */
  verifiedSkills: { id: string; term: string }[];
}

/** True for a non-blank string. Blank/whitespace-only text is nullable text left empty by LLM extraction, not a value. */
export const present = (s: string | null | undefined): s is string => typeof s === "string" && s.trim().length > 0;

export function contactLine(contact: ResumeContact): string | null {
  const parts = [contact.email, contact.phoneNumber, contact.linkedinUrl].filter(present);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function dateRange(start: string | null, end: string | null): string | null {
  if (present(start) && present(end)) return `${start} – ${end}`;
  if (present(start)) return `${start} – present`;
  if (present(end)) return end;
  return null;
}

/** Certification meta: unlike dateRange, an expiry-only certification reads as "Expires <date>", not a bare date. */
export function certDates(issueDate: string | null, expiryDate: string | null): string | null {
  if (present(issueDate) && present(expiryDate)) return `${issueDate} – ${expiryDate}`;
  if (present(issueDate)) return issueDate;
  if (present(expiryDate)) return `Expires ${expiryDate}`;
  return null;
}
