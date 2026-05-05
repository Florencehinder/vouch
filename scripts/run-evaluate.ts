import "../lib/env";
import { runEvaluate } from "../lib/evaluate-runner";

runEvaluate().then((r) => {
  console.log(`\ncompany_evaluate ${r.status}:`);
  console.log("  candidates:", r.stats.candidates);
  console.log("  evaluated:", r.stats.evaluated, "errors:", r.stats.errors);
  console.log("  by_tier:", r.stats.by_tier);
  console.log("  rows_written_to_sheet:", r.stats.rows_written_to_sheet);
  if (r.error) console.error("error:", r.error);
  process.exit(r.status === "error" ? 1 : 0);
});
