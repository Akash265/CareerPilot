import { ProfileClient } from "./ProfileClient";

export default function ProfilePage() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="mb-6 text-2xl font-semibold">Candidate Profile</h1>
      <ProfileClient />
    </main>
  );
}
