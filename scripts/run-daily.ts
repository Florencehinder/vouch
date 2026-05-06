import "../lib/env";

// Temporary debug: confirm env vars made it through to the runner
const u = process.env.SUPABASE_URL;
console.log(
  `SUPABASE_URL: present=${!!u} len=${u?.length ?? 0} startsWithHttps=${u?.startsWith("https://") ?? false} hasNewline=${u?.includes("\n") ?? false} hasCR=${u?.includes("\r") ?? false} firstChar=${u?.charCodeAt(0)} lastChar=${u?.charCodeAt((u?.length ?? 1) - 1)}`,
);

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
