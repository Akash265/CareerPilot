import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // @ai-career/config's `main`/`types` point directly at src/env.ts (raw
  // TypeScript, no build step). Next.js does not transpile workspace
  // packages by default, so without this the import can fail at dev/build
  // time when used from a Server Component. Empirically, Next.js 16.3.4's
  // default Turbopack bundler transforms this workspace-linked TS source
  // even without this flag (verified via a negative test — see
  // task-5-report.md), but transpilePackages is still declared explicitly:
  // it's the documented, bundler-agnostic way to opt a workspace package
  // into transformation, and protects against breakage if Webpack is ever
  // selected instead of Turbopack.
  transpilePackages: ["@ai-career/config", "@ai-career/db"],
};

export default nextConfig;
