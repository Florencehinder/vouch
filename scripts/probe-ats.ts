import "../lib/env";
import { supabaseService } from "../lib/supabase";
import { detect, fetchJobs } from "../lib/ats";
import type { AtsProvider, NormalizedJob } from "../lib/ats";

const TEST_SLUGS: Array<{ provider: Exclude<AtsProvider, "scrape" | "workday">; slug: string; label: string }> = [
  { provider: "greenhouse", slug: "anthropic", label: "Anthropic (Greenhouse)" },
  { provider: "lever", slug: "palantir", label: "Palantir (Lever)" },
  { provider: "ashby", slug: "openai", label: "OpenAI (Ashby)" },
  { provider: "smartrecruiters", slug: "visa", label: "Visa (SmartRecruiters)" },
];

function summarizeJob(j: NormalizedJob) {
  const desc = j.description_text.replace(/\s+/g, " ").trim();
  const descPreview = desc.length > 120 ? desc.slice(0, 117) + "..." : desc;
  return {
    external_id: j.external_id,
    title: j.title,
    location: j.location,
    url: j.url,
    description_chars: j.description_text.length,
    description_preview: descPreview,
    posted_at: j.posted_at?.toISOString() ?? null,
  };
}

async function probeDetection() {
  console.log("\n=== detection on companies in DB ===");
  const { data, error } = await supabaseService
    .from("companies")
    .select("name, careers_url");
  if (error) {
    console.error("failed to read companies:", error.message);
    return;
  }
  if (!data?.length) {
    console.log("(no companies in DB — run `pnpm sync` first)");
    return;
  }
  for (const c of data) {
    if (!c.careers_url) {
      console.log(`  ${c.name}: no careers_url`);
      continue;
    }
    try {
      const result = await detect(c.careers_url);
      console.log(`  ${c.name} (${c.careers_url}) -> ${JSON.stringify(result)}`);
    } catch (e) {
      console.log(`  ${c.name} (${c.careers_url}) -> ERROR ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function probeAdapters() {
  console.log("\n=== adapter smoke tests ===");
  for (const { provider, slug, label } of TEST_SLUGS) {
    process.stdout.write(`\n${label} -> ${provider}/${slug}\n`);
    const t0 = Date.now();
    try {
      const jobs = await fetchJobs(provider, slug);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  ${jobs.length} jobs in ${elapsed}s`);
      if (jobs.length) {
        console.log("  first job:");
        const sample = summarizeJob(jobs[0]);
        for (const [k, v] of Object.entries(sample)) {
          console.log(`    ${k}: ${v}`);
        }
      }
    } catch (e) {
      console.log(`  ERROR: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function main() {
  await probeDetection();
  await probeAdapters();
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
