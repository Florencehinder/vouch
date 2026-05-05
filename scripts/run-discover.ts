import "../lib/env";
import { runDiscover } from "../lib/discover";

runDiscover().then((r) => {
  console.log(`job_discover ${r.status}:`, r.stats);
  if (r.error) console.error("error:", r.error);
  process.exit(r.status === "error" ? 1 : 0);
});
