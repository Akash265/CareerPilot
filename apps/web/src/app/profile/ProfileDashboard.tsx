"use client";

import type { EditableProfile } from "./ReviewForm";

// Read-only mirror of ReviewForm: every field the review form can edit is
// displayed back here, so a user can verify what was actually persisted
// (D15's mandatory-review gate is only meaningful if the saved result is
// fully visible afterwards).

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function dateRange(startDate: string | null, endDate: string | null): string {
  if (startDate === null && endDate === null) return EMPTY;
  return `${startDate ?? EMPTY} – ${endDate ?? "Present"}`;
}

export function ProfileDashboard({
  profile,
  onEdit,
}: {
  profile: EditableProfile;
  onEdit: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">{profile.contact.fullName}</h2>
        <p className="text-sm text-gray-500">{profile.contact.email}</p>
      </div>

      <Section title="Contact">
        <Field label="Phone number" value={profile.contact.phoneNumber} />
        <Field label="LinkedIn URL" value={profile.contact.linkedinUrl} />
        <Field label="Address" value={profile.contact.addressLine1} />
      </Section>

      <Section title="Preferences">
        <Field
          label="Years of experience"
          value={profile.yearsOfExperience === null ? null : String(profile.yearsOfExperience)}
        />
        <Field label="Work mode preference" value={profile.workModePreference} />
        <Field
          label="Minimum salary expectation"
          value={profile.salaryExpectationMin === null ? null : String(profile.salaryExpectationMin)}
        />
        <Field
          label="Maximum salary expectation"
          value={profile.salaryExpectationMax === null ? null : String(profile.salaryExpectationMax)}
        />
        <Field label="Salary currency" value={profile.salaryCurrency} />
        <Field
          label="Visa sponsorship required"
          value={profile.visaSponsorshipRequired ? "Yes" : "No"}
        />
        <Field label="Work authorization notes" value={profile.workAuthorizationNotes} />
        <List label="Preferred role titles" values={profile.preferredRoleTitles} />
        <List label="Preferred industries" values={profile.preferredIndustries} />
        <List label="Excluded industries" values={profile.excludedIndustries} />
        <List label="Preferred companies" values={profile.preferredCompanies} />
        <List label="Excluded companies" values={profile.excludedCompanies} />
      </Section>

      <Section title="Education">
        {profile.education.length === 0 ? (
          <p className="text-sm text-gray-500">{EMPTY}</p>
        ) : (
          profile.education.map((entry, i) => (
            <div key={i} className="rounded border p-3">
              <p className="text-sm font-medium">{entry.institution}</p>
              <Field
                label="Degree"
                value={entry.fieldOfStudy === null ? entry.degree : `${entry.degree}, ${entry.fieldOfStudy}`}
              />
              <Field label="Dates" value={dateRange(entry.startDate, entry.endDate)} />
              <Field label="GPA" value={entry.gpa} />
            </div>
          ))
        )}
      </Section>

      <Section title="Work Experience">
        {profile.workExperiences.length === 0 ? (
          <p className="text-sm text-gray-500">{EMPTY}</p>
        ) : (
          profile.workExperiences.map((entry, i) => (
            <div key={i} className="rounded border p-3">
              <p className="text-sm font-medium">{`${entry.title} — ${entry.company}`}</p>
              <Field label="Location" value={entry.location} />
              <Field label="Employment type" value={entry.employmentType} />
              <Field label="Dates" value={dateRange(entry.startDate, entry.endDate)} />
              <List label="Highlights" values={entry.bullets} />
            </div>
          ))
        )}
      </Section>

      <Section title="Skills">
        <List
          label="Skills"
          values={profile.skills.map((skill) =>
            skill.category === null ? skill.name : `${skill.name} (${skill.category})`
          )}
        />
      </Section>

      <Section title="Projects">
        {profile.projects.length === 0 ? (
          <p className="text-sm text-gray-500">{EMPTY}</p>
        ) : (
          profile.projects.map((entry, i) => (
            <div key={i} className="rounded border p-3">
              <p className="text-sm font-medium">{entry.name}</p>
              <Field label="Description" value={entry.description} />
              <Field label="URL" value={entry.url} />
            </div>
          ))
        )}
      </Section>

      <Section title="Certifications">
        {profile.certifications.length === 0 ? (
          <p className="text-sm text-gray-500">{EMPTY}</p>
        ) : (
          profile.certifications.map((entry, i) => (
            <div key={i} className="rounded border p-3">
              <p className="text-sm font-medium">{entry.name}</p>
              <Field label="Issuer" value={entry.issuer} />
              <Field label="Issued" value={entry.issueDate} />
              <Field label="Expires" value={entry.expiryDate} />
            </div>
          ))
        )}
      </Section>

      <Section title="Achievements">
        <List label="Achievements" values={profile.achievements} />
      </Section>

      <button
        type="button"
        onClick={onEdit}
        className="w-fit rounded border px-4 py-2 text-sm"
      >
        Edit Profile
      </button>
    </div>
  );
}
