import "../lib/env";
import { runSync } from "../lib/sync";
import { runEvaluate } from "../lib/evaluate-runner";
import { runDiscover } from "../lib/discover";
import { runClassify } from "../lib/classify-runner";
import { runDigest } from "../lib/digest";

async function main() {
  const sync = await runSync();
  console.log(`sheet_sync ${sync.status}:`, sync.stats);

  const evaluate = await runEvaluate();
  console.log(`company_evaluate ${evaluate.status}:`, evaluate.stats);

  const discover = await runDiscover();
  console.log(`job_discover ${discover.status}:`, discover.stats);

  // classify-runner reads user feedback from the Jobs sheet directly at the
  // start of each run (see reloadSystemPrompt in lib/classify.ts).
  const classify = await runClassify();
  console.log(`job_classify ${classify.status}:`, classify.stats);

  const digest = await runDigest();
  console.log(`digest_email ${digest.status}:`, digest.stats);

  const anyError = [sync, evaluate, discover, classify, digest].some(
    (r) => r.status === "error",
  );
  process.exit(anyError ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
