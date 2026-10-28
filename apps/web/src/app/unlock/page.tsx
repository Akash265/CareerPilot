import { safeNextPath } from "../../lib/security/gate";
import { UnlockForm } from "./UnlockForm";

/** Phase 11c (D177): where proxy.ts sends a page request that has no access cookie. */
export default async function UnlockPage({ searchParams }: PageProps<"/unlock">) {
  const { next } = await searchParams;
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">Unlock CareerPilot</h1>
      <p className="text-sm text-gray-600">This instance is protected by an access token (APP_ACCESS_TOKEN in its .env).</p>
      <UnlockForm next={safeNextPath(typeof next === "string" ? next : null)} />
    </main>
  );
}
