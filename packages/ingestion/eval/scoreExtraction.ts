// Prints precision/recall per extracted field over the labeled set.  Run: pnpm --filter @ai-career/ingestion eval:extraction
import { CASES } from "./cases";
import { scoreExtraction } from "./score";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const scores = scoreExtraction(CASES);

console.log(`Extraction eval — ${CASES.length} labeled cases\n`);
console.log("field          cases   tp   fp   fn   tn   precision   recall");
for (const s of scores) {
  console.log(
    `${s.field.padEnd(14)} ${String(s.cases).padStart(5)} ${String(s.tp).padStart(4)} ${String(s.fp).padStart(4)} ${String(s.fn).padStart(4)} ${String(s.tn).padStart(4)}   ${pct(s.precision).padStart(9)}   ${pct(s.recall).padStart(6)}`
  );
}
process.exit(scores.every((s) => s.precision === 1 && s.recall === 1) ? 0 : 1);
