"use client";

import type { EditableProfile } from "./ReviewForm";

export function ProfileDashboard({
  profile,
  onEdit,
}: {
  profile: EditableProfile;
  onEdit: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{profile.contact.fullName}</h2>
        <p className="text-sm text-gray-500">{profile.contact.email}</p>
      </div>
      <div>
        <h3 className="text-sm font-medium">Skills</h3>
        <ul className="list-disc pl-5 text-sm">
          {profile.skills.map((skill, i) => (
            <li key={i}>{skill.name}</li>
          ))}
        </ul>
      </div>
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
