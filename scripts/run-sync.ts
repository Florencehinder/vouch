import "../lib/env";
import { runSync } from "../lib/sync";

runSync().then((r) => {
  if (r.status === "ok") {
    console.log("sheet_sync ok:", r.stats);
    process.exit(0);
  } else {
    console.error("sheet_sync failed:", r.error);
    process.exit(1);
  }
});
