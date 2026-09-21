import { JobDetailClient } from "./JobDetailClient";

// Next 16: dynamic route params arrive as a Promise.
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-3xl p-8">
      <JobDetailClient id={id} />
    </main>
  );
}
