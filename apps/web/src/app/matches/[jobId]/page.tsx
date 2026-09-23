import { MatchDetailClient } from "./MatchDetailClient";

// Next 16: dynamic route params arrive as a Promise.
export default async function MatchPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return (
    <main className="mx-auto max-w-3xl p-8">
      <MatchDetailClient jobId={jobId} />
    </main>
  );
}
