import "../lib/env";
import { runSync } from "../lib/sync";
import { runEvaluate } from "../lib/evaluate-runner";
import { runDiscover } from "../lib/discover";
import { runClassify } from "../lib/classify-runner";
import { runDigest } from "../lib/digest";

function log(r: { kind: string; status: string; stats: unknown; error?: string }) {
  console.log(`${r.kind} ${r.status}:`, r.stats);
  if (r.error) console.error(`  ${r.kind} ERROR: ${r.error}`);
}

async function main() {
  const sync = await runSync();
  log(sync);

  const evaluate = await runEvaluate();
  log(evaluate);

  const discover = await runDiscover();
  log(discover);

  // classify-runner reads user feedback from the Jobs sheet directly at the
  // start of each run (see reloadSystemPrompt in lib/classify.ts).
  const classify = await runClassify();
  log(classify);

  const digest = await runDigest();
  log(digest);

  const anyError = [sync, evaluate, discover, classify, digest].some(
    (r) => r.status === "error",
  );
  process.exit(anyError ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
