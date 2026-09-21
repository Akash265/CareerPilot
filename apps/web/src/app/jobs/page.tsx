import { JobsClient } from "./JobsClient";

export default function JobsPage() {
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="mb-2 text-2xl font-semibold">Jobs</h1>
      <p className="mb-6 text-sm text-gray-600">
        Everything ingested from your sources, newest first. Ranking and matching against your career goal come in a later phase.
      </p>
      <JobsClient />
    </main>
  );
}
