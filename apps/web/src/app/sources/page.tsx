import { SourcesClient } from "./SourcesClient";

export default function SourcesPage() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="mb-2 text-2xl font-semibold">Job sources</h1>
      <p className="mb-6 text-sm text-gray-600">
        Jobs come only from sources you add and confirm. Greenhouse and Lever expose one board per company, so this is
        a watch-list of the companies you want to follow.
      </p>
      <SourcesClient />
    </main>
  );
}
