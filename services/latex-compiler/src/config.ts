export interface CompilerConfig { token: string; port: number; testMode: boolean }

/** The compiler gets only what it needs from the environment -- never the app's .env (Phase 13c spec §5). */
export function loadCompilerConfig(env: NodeJS.ProcessEnv): CompilerConfig {
  const token = env.LATEX_COMPILER_TOKEN?.trim() ?? "";
  if (token.length < 32) throw new Error("LATEX_COMPILER_TOKEN must be set (at least 32 characters)");
  const port = env.PORT ? Number(env.PORT) : 8090;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
  return { token, port, testMode: env.LATEX_COMPILER_TEST_MODE === "1" };
}
