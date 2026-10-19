import { SkillsClient } from "./SkillsClient";

export default function SkillsPage() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="mb-2 text-2xl font-semibold">Verify skills</h1>
      <p className="mb-6 text-sm text-gray-600">
        Required skills your top matches ask for that we couldn&apos;t find in your profile. Answer each once: a skill you
        have — with one sentence on where you used it — can then appear in your resumes and cover letters. Answers do not
        change match scores.
      </p>
      <SkillsClient />
    </main>
  );
}
