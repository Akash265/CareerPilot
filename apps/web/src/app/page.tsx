import { loadEnv } from "@ai-career/config";

export default function Home() {
  const env = loadEnv();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2">
      <h1 className="text-2xl font-semibold">AI Career Intelligence</h1>
      <p className="text-sm text-gray-500">
        Foundation phase running in {env.NODE_ENV} mode.
      </p>
    </main>
  );
}
