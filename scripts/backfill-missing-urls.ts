import "../lib/env";
import { updateMissingCareerUrls } from "../lib/sheets";

const URLS: Array<[string, string]> = [
  ["Weights & Biases", "https://coreweave.com/careers/weights-biases"],
  ["PhysicsX", "https://job-boards.eu.greenhouse.io/physicsx"],
  ["Peregrine", "https://job-boards.greenhouse.io/peregrinetechnologies"],
  ["Langchain", "https://jobs.ashbyhq.com/langchain"],
  ["Lakera AI", "https://jobs.ashbyhq.com/lakera"],
];

async function main() {
  const result = await updateMissingCareerUrls(new Map(URLS));
  console.log(`updated: ${result.updated}, skipped (already had URL): ${result.skipped}`);
  if (result.not_found.length) console.log("not found in sheet:", result.not_found);
}

main().catch((e) => { console.error(e); process.exit(1); });
