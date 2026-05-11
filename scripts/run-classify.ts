import "../lib/env";
import { runClassify } from "../lib/classify-runner";

runClassify().then((r) => {
  console.log(`job_classify ${r.status}:`);
  console.log("  candidates:", r.stats.candidates);
  console.log("  hard_excluded:", r.stats.hard_excluded, r.stats.hard_excluded_by_reason);
  console.log("  haiku_calls:", r.stats.haiku_calls, "errors:", r.stats.haiku_errors);
  console.log("  feedback_examples_used:", r.stats.feedback_examples_used);
  console.log("  results_by_category:", r.stats.results_by_category);
  if (r.error) console.error("error:", r.error);
  process.exit(r.status === "error" ? 1 : 0);
});
