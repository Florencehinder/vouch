import "../lib/env";
import { updateMissingCareerUrls } from "../lib/sheets";

// Confirmed via real job-count probes (only writes companies whose careers_url cell is currently empty).
const RESOLVED: Record<string, string> = {
  Palantir: "https://jobs.lever.co/palantir",
  OpenAI: "https://jobs.ashbyhq.com/openai",
  ElevenLabs: "https://jobs.ashbyhq.com/elevenlabs",
  Asana: "https://job-boards.greenhouse.io/asana",
  Stripe: "https://job-boards.greenhouse.io/stripe",
  Halter: "https://jobs.ashbyhq.com/halter",
  "Google Deepmind": "https://job-boards.greenhouse.io/deepmind",
  Monzo: "https://job-boards.greenhouse.io/monzo",
  Sierra: "https://jobs.ashbyhq.com/sierra",
  AISI: "https://job-boards.greenhouse.io/aisi",
  Helsing: "https://job-boards.greenhouse.io/helsing",
  Toast: "https://job-boards.greenhouse.io/toast",
  Faculty: "https://jobs.ashbyhq.com/faculty",
  "Mistral AI": "https://jobs.ashbyhq.com/mistral",
  Encord: "https://jobs.ashbyhq.com/encord",
  Decagon: "https://jobs.ashbyhq.com/decagon",
};

async function main() {
  const result = await updateMissingCareerUrls(new Map(Object.entries(RESOLVED)));
  console.log("backfill complete:");
  console.log(`  updated:  ${result.updated} cells`);
  console.log(`  skipped:  ${result.skipped} (already had a URL)`);
  console.log(`  not_found in sheet: ${result.not_found.length}`);
  if (result.not_found.length) {
    for (const n of result.not_found) console.log(`    - ${n}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
