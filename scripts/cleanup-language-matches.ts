// One-off cleanup after adding language-based excludes to the Excludes tab.
// Finds existing high-confidence matches whose titles match the new language
// patterns, deletes their job_matches rows, and flips Is_Open to FALSE in the
// Jobs sheet so they visually demote without removing the row entirely.

import "../lib/env";
import { supabaseService } from "../lib/supabase";
import { readJobsTabSnapshot, updateJobRowFields } from "../lib/sheets";

// Mirror of the regex used by the Excludes tab rows
const LANGUAGE_RE =
  /\b(german|deutsch|spanish|castilian|español|espanol|italian|italiano|portuguese|portugues|português|brazilian portuguese|dutch|nederlands|flemish|polish|polski|swedish|norwegian|danish|finnish|nordic|scandinavian|svenska|norsk|dansk|suomi|mandarin|cantonese|chinese|japanese|nihongo|korean|russian|czech|hungarian|romanian|ukrainian|bulgarian|slovak|slovenian|croatian|serbian|arabic|turkish|hebrew|greek)[\s-]?(speaking|speaker|native|fluent|required|fluency|proficiency)\b|\b(fluent|native|business[\s-]?level|professional[\s-]?level|c1|c2)\s+(in\s+)?(german|deutsch|spanish|castilian|español|italian|italiano|portuguese|portugues|português|dutch|nederlands|flemish|polish|polski|swedish|norwegian|danish|finnish|mandarin|cantonese|chinese|japanese|nihongo|korean|russian|czech|hungarian|romanian|ukrainian|bulgarian|slovak|arabic|turkish|hebrew|greek)\b/i;

type MatchRow = {
  job_id: string;
  matched_role_category: string;
  match_score: number;
  jobs: { title: string; url: string };
};

async function main() {
  // 1. Find high-confidence matches whose titles match the language pattern
  const { data, error } = await supabaseService
    .from("job_matches")
    .select("job_id, matched_role_category, match_score, jobs!inner(title, url)")
    .neq("matched_role_category", "none")
    .gte("match_score", 0.6);
  if (error) throw error;

  const targets = ((data ?? []) as unknown as MatchRow[]).filter((m) =>
    LANGUAGE_RE.test(m.jobs.title),
  );

  if (targets.length === 0) {
    console.log("Nothing to clean up.");
    return;
  }

  console.log(`Found ${targets.length} matches to retire:`);
  for (const m of targets) {
    console.log(`  ${m.matched_role_category}@${m.match_score} — ${m.jobs.title}`);
  }

  // 2. Delete job_matches rows
  const jobIds = targets.map((t) => t.job_id);
  const { error: delErr } = await supabaseService
    .from("job_matches")
    .delete()
    .in("job_id", jobIds);
  if (delErr) throw delErr;
  console.log(`\nDeleted ${jobIds.length} job_matches rows.`);

  // 3. Flip Is_Open=FALSE in Jobs sheet for these URLs (DB jobs.is_open untouched)
  const targetUrls = new Set(targets.map((t) => t.jobs.url));
  const snapshot = await readJobsTabSnapshot();
  const sheetUpdates = snapshot
    .filter((row) => targetUrls.has(row.url))
    .map((row) => ({ rowIndex: row.rowIndex, isOpen: false }));

  if (sheetUpdates.length) {
    await updateJobRowFields(sheetUpdates);
    console.log(`Marked ${sheetUpdates.length} Jobs-sheet rows as Is_Open=FALSE.`);
  } else {
    console.log("No matching rows found in Jobs sheet (already removed?).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
