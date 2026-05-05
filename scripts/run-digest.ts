import "../lib/env";
import { runDigest } from "../lib/digest";

runDigest().then((r) => {
  console.log(`digest_email ${r.status}:`, r.stats);
  if (r.error) console.error("error:", r.error);
  process.exit(r.status === "error" ? 1 : 0);
});
