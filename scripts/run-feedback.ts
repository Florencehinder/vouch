import "../lib/env";
import { runFeedback } from "../lib/feedback-runner";

runFeedback().then((r) => {
  console.log(`feedback_sync ${r.status}:`, r.stats);
  if (r.error) console.error("error:", r.error);
  process.exit(r.status === "error" ? 1 : 0);
});
