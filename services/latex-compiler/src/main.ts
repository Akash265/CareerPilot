import { createLogger, serializeError } from "@ai-career/logging";
import { loadCompilerConfig } from "./config";
import { compileTex } from "./compile";
import { runPdflatex } from "./runPdflatex";
import { createLimiter } from "./limiter";
import { createCompilerServer } from "./server";
import { extractPdfText } from "./extract";
import { readTexVersion } from "./texVersion";

const log = createLogger({ service: "latex-compiler" });

async function main(): Promise<void> {
  const config = loadCompilerConfig(process.env);
  const texVersion = await readTexVersion();
  const server = createCompilerServer({
    token: config.token,
    texVersion,
    compile: (tex) => compileTex(tex, runPdflatex),
    limiter: createLimiter({ concurrency: 2, maxQueue: 4 }),
    logger: log,
    ...(config.testMode ? { extract: extractPdfText } : {}),
  });
  server.listen(config.port, "0.0.0.0", () => log.info("latex_compiler.started", { port: config.port, texVersion, testMode: config.testMode }));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  log.error("latex_compiler.start_failed", { error: serializeError(err) });
  process.exit(1);
});
