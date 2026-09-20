import Link from "next/link";
import { loadEnv } from "@ai-career/config";

export default function Home() {
  const env = loadEnv();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold">AI Career Intelligence</h1>
        <p className="text-sm text-gray-500">Running in {env.NODE_ENV} mode.</p>
      </div>
      <nav aria-label="Get started" className="flex flex-col items-center gap-2 text-sm">
        <Link href="/profile" className="underline">
          1. Candidate profile — upload your resume and review it
        </Link>
        <Link href="/career-goal" className="underline">
          2. Career goal — describe the roles you want
        </Link>
      </nav>
    </main>
  );
}
