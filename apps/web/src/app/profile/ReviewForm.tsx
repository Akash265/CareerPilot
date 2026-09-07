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

type EducationEntry = EditableProfile["education"][number];
type WorkExperienceEntry = EditableProfile["workExperiences"][number];
type SkillEntry = EditableProfile["skills"][number];
type ProjectEntry = EditableProfile["projects"][number];
type CertificationEntry = EditableProfile["certifications"][number];

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

// ---------------------------------------------------------------------------
// Value conversion helpers
//
// Nullable string columns are edited through plain text inputs, so every
// nullable field round-trips as `value ?? ""` on the way in and
// `orNull(input)` on the way out: a blank/whitespace-only input means "no
// value" (null), never an empty string. Required string columns (institution,
// degree, company, title, skill/project/certification names) keep "" so a
// half-filled row stays editable; ConfirmedProfileSchema accepts "" for those
// and the server is the single source of truth on required-ness.
//
// The comma-list and newline-bullet fields deliberately do NOT drop empty
// entries while typing -- doing so would swallow the separator the user just
// typed in a controlled input ("a," -> ["a"] -> "a"). Empty entries are
// stripped once, in `toPayload`, immediately before the request is sent.
// ---------------------------------------------------------------------------

const orNull = (value: string): string | null => (value.trim() === "" ? null : value);

const orNullNumber = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
};

const fromCommaList = (value: string): string[] => value.split(",").map((part) => part.trim());
const toCommaList = (values: string[]): string => values.join(", ");

const fromLines = (value: string): string[] => value.split("\n");
const toLines = (values: string[]): string => values.join("\n");

const nonEmpty = (values: string[]): string[] => values.filter((value) => value.trim() !== "");

function replaceAt<T>(list: T[], index: number, patch: Partial<T>): T[] {
  return list.map((item, i) => (i === index ? { ...item, ...patch } : item));
}

function removeAt<T>(list: T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

const EMPTY_EDUCATION: EducationEntry = {
  institution: "",
  degree: "",
  fieldOfStudy: null,
  startDate: null,
  endDate: null,
  gpa: null,
};

const EMPTY_WORK_EXPERIENCE: WorkExperienceEntry = {
  company: "",
  title: "",
  location: null,
  employmentType: null,
  startDate: null,
  endDate: null,
  bullets: [],
};

const EMPTY_SKILL: SkillEntry = { name: "", category: null };
const EMPTY_PROJECT: ProjectEntry = { name: "", description: "", url: null };
const EMPTY_CERTIFICATION: CertificationEntry = {
  name: "",
  issuer: "",
  issueDate: null,
  expiryDate: null,
};

/** Strips the placeholder empties that only exist to keep typing natural. */
export function toPayload(profile: EditableProfile): EditableProfile {
  return {
    ...profile,
    preferredRoleTitles: nonEmpty(profile.preferredRoleTitles),
    preferredIndustries: nonEmpty(profile.preferredIndustries),
    excludedIndustries: nonEmpty(profile.excludedIndustries),
    preferredCompanies: nonEmpty(profile.preferredCompanies),
    excludedCompanies: nonEmpty(profile.excludedCompanies),
    achievements: nonEmpty(profile.achievements),
    workExperiences: profile.workExperiences.map((exp) => ({
      ...exp,
      bullets: nonEmpty(exp.bullets),
    })),
  };
}

// ---------------------------------------------------------------------------
// Small presentational primitives (kept local -- these exist only to stop the
// ~50 form controls below from being 50 copies of the same markup).
// ---------------------------------------------------------------------------

function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number";
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full rounded border px-2 py-1"
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function EntryCard({
  legend,
  onRemove,
  children,
}: {
  legend: string;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{legend}</span>
        <button type="button" onClick={onRemove} className="rounded border px-2 py-1 text-xs">
          Remove {legend}
        </button>
      </div>
      {children}
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-fit rounded border px-3 py-1 text-sm">
      {label}
    </button>
  );
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

  function setField<K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
  }

  function setContact<K extends keyof EditableProfile["contact"]>(
    key: K,
    value: EditableProfile["contact"][K]
  ) {
    setProfile((p) => ({ ...p, contact: { ...p.contact, [key]: value } }));
  }

  async function handleConfirm() {
    setIsSaving(true);
    try {
      const res = await fetch("/api/profile/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPayload(profile)),
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
    <div className="flex flex-col gap-6">
      <Section title="Contact">
        <TextField
          id="full-name"
          label="Full name"
          value={profile.contact.fullName}
          onChange={(v) => setContact("fullName", v)}
        />
        <TextField
          id="email"
          label="Email"
          value={profile.contact.email}
          onChange={(v) => setContact("email", v)}
        />
        <TextField
          id="phone-number"
          label="Phone number"
          value={profile.contact.phoneNumber ?? ""}
          onChange={(v) => setContact("phoneNumber", orNull(v))}
        />
        <TextField
          id="linkedin-url"
          label="LinkedIn URL"
          value={profile.contact.linkedinUrl ?? ""}
          onChange={(v) => setContact("linkedinUrl", orNull(v))}
        />
        <TextField
          id="address-line1"
          label="Address"
          value={profile.contact.addressLine1 ?? ""}
          onChange={(v) => setContact("addressLine1", orNull(v))}
        />
      </Section>

      <Section title="Preferences">
        <TextField
          id="years-of-experience"
          label="Years of experience"
          type="number"
          value={profile.yearsOfExperience === null ? "" : String(profile.yearsOfExperience)}
          onChange={(v) => setField("yearsOfExperience", orNullNumber(v))}
        />
        <div>
          <label htmlFor="work-mode-preference" className="text-sm font-medium">
            Work mode preference
          </label>
          <select
            id="work-mode-preference"
            value={profile.workModePreference}
            onChange={(e) =>
              setField("workModePreference", e.target.value as EditableProfile["workModePreference"])
            }
            className="block w-full rounded border px-2 py-1"
          >
            <option value="remote">remote</option>
            <option value="hybrid">hybrid</option>
            <option value="onsite">onsite</option>
            <option value="any">any</option>
          </select>
        </div>
        <TextField
          id="salary-min"
          label="Minimum salary expectation"
          type="number"
          value={profile.salaryExpectationMin === null ? "" : String(profile.salaryExpectationMin)}
          onChange={(v) => setField("salaryExpectationMin", orNullNumber(v))}
        />
        <TextField
          id="salary-max"
          label="Maximum salary expectation"
          type="number"
          value={profile.salaryExpectationMax === null ? "" : String(profile.salaryExpectationMax)}
          onChange={(v) => setField("salaryExpectationMax", orNullNumber(v))}
        />
        <TextField
          id="salary-currency"
          label="Salary currency"
          value={profile.salaryCurrency ?? ""}
          onChange={(v) => setField("salaryCurrency", orNull(v))}
        />
        <div className="flex items-center gap-2">
          <input
            id="visa-sponsorship-required"
            type="checkbox"
            checked={profile.visaSponsorshipRequired}
            onChange={(e) => setField("visaSponsorshipRequired", e.target.checked)}
            className="rounded border"
          />
          <label htmlFor="visa-sponsorship-required" className="text-sm font-medium">
            Visa sponsorship required
          </label>
        </div>
        <div>
          <label htmlFor="work-authorization-notes" className="text-sm font-medium">
            Work authorization notes
          </label>
          <textarea
            id="work-authorization-notes"
            value={profile.workAuthorizationNotes ?? ""}
            onChange={(e) => setField("workAuthorizationNotes", orNull(e.target.value))}
            className="block w-full rounded border px-2 py-1"
            rows={2}
          />
        </div>
        <TextField
          id="preferred-role-titles"
          label="Preferred role titles (comma separated)"
          value={toCommaList(profile.preferredRoleTitles)}
          onChange={(v) => setField("preferredRoleTitles", fromCommaList(v))}
        />
        <TextField
          id="preferred-industries"
          label="Preferred industries (comma separated)"
          value={toCommaList(profile.preferredIndustries)}
          onChange={(v) => setField("preferredIndustries", fromCommaList(v))}
        />
        <TextField
          id="excluded-industries"
          label="Excluded industries (comma separated)"
          value={toCommaList(profile.excludedIndustries)}
          onChange={(v) => setField("excludedIndustries", fromCommaList(v))}
        />
        <TextField
          id="preferred-companies"
          label="Preferred companies (comma separated)"
          value={toCommaList(profile.preferredCompanies)}
          onChange={(v) => setField("preferredCompanies", fromCommaList(v))}
        />
        <TextField
          id="excluded-companies"
          label="Excluded companies (comma separated)"
          value={toCommaList(profile.excludedCompanies)}
          onChange={(v) => setField("excludedCompanies", fromCommaList(v))}
        />
      </Section>

      <Section title="Education">
        {profile.education.map((entry, i) => (
          <EntryCard
            key={i}
            legend={`Education ${i + 1}`}
            onRemove={() => setField("education", removeAt(profile.education, i))}
          >
            <TextField
              id={`education-${i}-institution`}
              label={`Institution ${i + 1}`}
              value={entry.institution}
              onChange={(v) => setField("education", replaceAt(profile.education, i, { institution: v }))}
            />
            <TextField
              id={`education-${i}-degree`}
              label={`Degree ${i + 1}`}
              value={entry.degree}
              onChange={(v) => setField("education", replaceAt(profile.education, i, { degree: v }))}
            />
            <TextField
              id={`education-${i}-field-of-study`}
              label={`Field of study ${i + 1}`}
              value={entry.fieldOfStudy ?? ""}
              onChange={(v) =>
                setField("education", replaceAt(profile.education, i, { fieldOfStudy: orNull(v) }))
              }
            />
            <TextField
              id={`education-${i}-start-date`}
              label={`Education start date ${i + 1}`}
              value={entry.startDate ?? ""}
              onChange={(v) =>
                setField("education", replaceAt(profile.education, i, { startDate: orNull(v) }))
              }
            />
            <TextField
              id={`education-${i}-end-date`}
              label={`Education end date ${i + 1}`}
              value={entry.endDate ?? ""}
              onChange={(v) =>
                setField("education", replaceAt(profile.education, i, { endDate: orNull(v) }))
              }
            />
            <TextField
              id={`education-${i}-gpa`}
              label={`GPA ${i + 1}`}
              value={entry.gpa ?? ""}
              onChange={(v) => setField("education", replaceAt(profile.education, i, { gpa: orNull(v) }))}
            />
          </EntryCard>
        ))}
        <AddButton
          label="Add Education"
          onClick={() => setField("education", [...profile.education, { ...EMPTY_EDUCATION }])}
        />
      </Section>

      <Section title="Work Experience">
        {profile.workExperiences.map((entry, i) => (
          <EntryCard
            key={i}
            legend={`Work Experience ${i + 1}`}
            onRemove={() => setField("workExperiences", removeAt(profile.workExperiences, i))}
          >
            <TextField
              id={`work-${i}-company`}
              label={`Company ${i + 1}`}
              value={entry.company}
              onChange={(v) =>
                setField("workExperiences", replaceAt(profile.workExperiences, i, { company: v }))
              }
            />
            <TextField
              id={`work-${i}-title`}
              label={`Job title ${i + 1}`}
              value={entry.title}
              onChange={(v) =>
                setField("workExperiences", replaceAt(profile.workExperiences, i, { title: v }))
              }
            />
            <TextField
              id={`work-${i}-location`}
              label={`Location ${i + 1}`}
              value={entry.location ?? ""}
              onChange={(v) =>
                setField(
                  "workExperiences",
                  replaceAt(profile.workExperiences, i, { location: orNull(v) })
                )
              }
            />
            <TextField
              id={`work-${i}-employment-type`}
              label={`Employment type ${i + 1}`}
              value={entry.employmentType ?? ""}
              onChange={(v) =>
                setField(
                  "workExperiences",
                  replaceAt(profile.workExperiences, i, { employmentType: orNull(v) })
                )
              }
            />
            <TextField
              id={`work-${i}-start-date`}
              label={`Work start date ${i + 1}`}
              value={entry.startDate ?? ""}
              onChange={(v) =>
                setField(
                  "workExperiences",
                  replaceAt(profile.workExperiences, i, { startDate: orNull(v) })
                )
              }
            />
            <TextField
              id={`work-${i}-end-date`}
              label={`Work end date ${i + 1}`}
              value={entry.endDate ?? ""}
              onChange={(v) =>
                setField(
                  "workExperiences",
                  replaceAt(profile.workExperiences, i, { endDate: orNull(v) })
                )
              }
            />
            <div>
              <label htmlFor={`work-${i}-bullets`} className="text-sm font-medium">
                {`Bullets ${i + 1} (one per line)`}
              </label>
              <textarea
                id={`work-${i}-bullets`}
                value={toLines(entry.bullets)}
                onChange={(e) =>
                  setField(
                    "workExperiences",
                    replaceAt(profile.workExperiences, i, { bullets: fromLines(e.target.value) })
                  )
                }
                className="block w-full rounded border px-2 py-1"
                rows={4}
              />
            </div>
          </EntryCard>
        ))}
        <AddButton
          label="Add Work Experience"
          onClick={() =>
            setField("workExperiences", [
              ...profile.workExperiences,
              { ...EMPTY_WORK_EXPERIENCE, bullets: [] },
            ])
          }
        />
      </Section>

      <Section title="Skills">
        {profile.skills.map((entry, i) => (
          <EntryCard
            key={i}
            legend={`Skill ${i + 1}`}
            onRemove={() => setField("skills", removeAt(profile.skills, i))}
          >
            <TextField
              id={`skill-${i}-name`}
              label={`Skill name ${i + 1}`}
              value={entry.name}
              onChange={(v) => setField("skills", replaceAt(profile.skills, i, { name: v }))}
            />
            <TextField
              id={`skill-${i}-category`}
              label={`Skill category ${i + 1}`}
              value={entry.category ?? ""}
              onChange={(v) => setField("skills", replaceAt(profile.skills, i, { category: orNull(v) }))}
            />
          </EntryCard>
        ))}
        <AddButton
          label="Add Skill"
          onClick={() => setField("skills", [...profile.skills, { ...EMPTY_SKILL }])}
        />
      </Section>

      <Section title="Projects">
        {profile.projects.map((entry, i) => (
          <EntryCard
            key={i}
            legend={`Project ${i + 1}`}
            onRemove={() => setField("projects", removeAt(profile.projects, i))}
          >
            <TextField
              id={`project-${i}-name`}
              label={`Project name ${i + 1}`}
              value={entry.name}
              onChange={(v) => setField("projects", replaceAt(profile.projects, i, { name: v }))}
            />
            <TextField
              id={`project-${i}-description`}
              label={`Project description ${i + 1}`}
              value={entry.description}
              onChange={(v) => setField("projects", replaceAt(profile.projects, i, { description: v }))}
            />
            <TextField
              id={`project-${i}-url`}
              label={`Project URL ${i + 1}`}
              value={entry.url ?? ""}
              onChange={(v) => setField("projects", replaceAt(profile.projects, i, { url: orNull(v) }))}
            />
          </EntryCard>
        ))}
        <AddButton
          label="Add Project"
          onClick={() => setField("projects", [...profile.projects, { ...EMPTY_PROJECT }])}
        />
      </Section>

      <Section title="Certifications">
        {profile.certifications.map((entry, i) => (
          <EntryCard
            key={i}
            legend={`Certification ${i + 1}`}
            onRemove={() => setField("certifications", removeAt(profile.certifications, i))}
          >
            <TextField
              id={`certification-${i}-name`}
              label={`Certification name ${i + 1}`}
              value={entry.name}
              onChange={(v) =>
                setField("certifications", replaceAt(profile.certifications, i, { name: v }))
              }
            />
            <TextField
              id={`certification-${i}-issuer`}
              label={`Certification issuer ${i + 1}`}
              value={entry.issuer}
              onChange={(v) =>
                setField("certifications", replaceAt(profile.certifications, i, { issuer: v }))
              }
            />
            <TextField
              id={`certification-${i}-issue-date`}
              label={`Certification issue date ${i + 1}`}
              value={entry.issueDate ?? ""}
              onChange={(v) =>
                setField(
                  "certifications",
                  replaceAt(profile.certifications, i, { issueDate: orNull(v) })
                )
              }
            />
            <TextField
              id={`certification-${i}-expiry-date`}
              label={`Certification expiry date ${i + 1}`}
              value={entry.expiryDate ?? ""}
              onChange={(v) =>
                setField(
                  "certifications",
                  replaceAt(profile.certifications, i, { expiryDate: orNull(v) })
                )
              }
            />
          </EntryCard>
        ))}
        <AddButton
          label="Add Certification"
          onClick={() =>
            setField("certifications", [...profile.certifications, { ...EMPTY_CERTIFICATION }])
          }
        />
      </Section>

      <Section title="Achievements">
        {profile.achievements.map((entry, i) => (
          <EntryCard
            key={i}
            legend={`Achievement ${i + 1}`}
            onRemove={() => setField("achievements", removeAt(profile.achievements, i))}
          >
            <TextField
              id={`achievement-${i}`}
              label={`Achievement text ${i + 1}`}
              value={entry}
              onChange={(v) =>
                setField(
                  "achievements",
                  profile.achievements.map((a, j) => (j === i ? v : a))
                )
              }
            />
          </EntryCard>
        ))}
        <AddButton
          label="Add Achievement"
          onClick={() => setField("achievements", [...profile.achievements, ""])}
        />
      </Section>

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
