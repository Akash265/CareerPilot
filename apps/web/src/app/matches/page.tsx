import { MatchesClient } from "./MatchesClient";

export default function MatchesPage() {
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="mb-2 text-2xl font-semibold">Matches</h1>
      <p className="mb-6 text-sm text-gray-600">
        Jobs ranked against your confirmed career goal, with why each one scored the way it did.
      </p>
      <MatchesClient />
    </main>
  );
}
