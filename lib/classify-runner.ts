import { supabaseService } from "./supabase";
import { loadFilterConfig, applyHardExclude } from "./filter";
import { classifyJob, CLASSIFICATION_VERSION, reloadSystemPrompt } from "./classify";
import type { StepResult } from "./sync";

type JobRow = {
  id: string;
  company_id: string;
  external_id: string;
  title: string;
  location: string | null;
  description_text: string | null;
  companies: { name: string; tier: string | null } | { name: string; tier: string | null }[] | null;
};

const TIERS_THAT_CLASSIFY = new Set(["A", "B"]);

export type ClassifyStats = {
  candidates: number;
  hard_excluded: number;
  hard_excluded_by_reason: Record<string, number>;
  haiku_calls: number;
  haiku_errors: number;
  results_by_category: { pm: number; ds_fde: number; tpm: number; program_mgr: number; none: number };
  classification_version: string;
  feedback_examples_used: number;
};

async function fetchUnclassified(): Promise<JobRow[]> {
  const pageSize = 1000;
  const out: JobRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseService
      .from("jobs")
      .select(
        "id, company_id, external_id, title, location, description_text, companies(name, tier), job_matches!left(id, classification_version)",
      )
      .eq("is_open", true)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    type Match = { id: string; classification_version: string | null };
    const batch = (data ?? []) as Array<JobRow & { job_matches: Match | Match[] | null }>;
    for (const j of batch) {
      const co = Array.isArray(j.companies) ? j.companies[0] : j.companies;
      if (!co?.tier || !TIERS_THAT_CLASSIFY.has(co.tier)) continue;
      const raw = j.job_matches;
      const matches: Match[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const hasCurrent = matches.some((m) => m.classification_version === CLASSIFICATION_VERSION);
      if (!hasCurrent) {
        const { job_matches: _ignored, ...rest } = j;
        out.push(rest as JobRow);
      }
    }
    if (batch.length < pageSize) return out;
    from += pageSize;
  }
}

function companyName(row: JobRow): string {
  if (!row.companies) return "(unknown)";
  if (Array.isArray(row.companies)) return row.companies[0]?.name ?? "(unknown)";
  return row.companies.name;
}

export async function runClassify(): Promise<StepResult<ClassifyStats>> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const stats: ClassifyStats = {
    candidates: 0,
    hard_excluded: 0,
    hard_excluded_by_reason: {},
    haiku_calls: 0,
    haiku_errors: 0,
    results_by_category: { pm: 0, ds_fde: 0, tpm: 0, program_mgr: 0, none: 0 },
    classification_version: CLASSIFICATION_VERSION,
    feedback_examples_used: 0,
  };

  try {
    // Rebuild the Haiku system prompt from current feedback before any classification
    const reload = await reloadSystemPrompt();
    stats.feedback_examples_used = reload.examples_used;

    const config = await loadFilterConfig();
    const candidates = await fetchUnclassified();
    stats.candidates = candidates.length;

    for (const job of candidates) {
      const cname = companyName(job);
      const decision = applyHardExclude(
        { title: job.title, location: job.location, description_text: job.description_text },
        config,
      );
      if (decision.excluded) {
        stats.hard_excluded++;
        stats.hard_excluded_by_reason[decision.reason] =
          (stats.hard_excluded_by_reason[decision.reason] ?? 0) + 1;
        continue;
      }

      try {
        const result = await classifyJob({
          title: job.title,
          company_name: cname,
          location: job.location,
          description_text: job.description_text ?? "",
        });
        stats.haiku_calls++;
        stats.results_by_category[result.category]++;

        const { error: upErr } = await supabaseService.from("job_matches").upsert(
          {
            job_id: job.id,
            matched_role_category: result.category,
            match_score: result.confidence,
            classification_version: CLASSIFICATION_VERSION,
            classification_reasoning: result.reasoning,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "job_id" },
        );
        if (upErr) throw upErr;
      } catch (e) {
        stats.haiku_errors++;
        console.warn(`  ERROR classifying ${cname} "${job.title}": ${e instanceof Error ? e.message : e}`);
      }
    }

    const status: "ok" | "partial" | "error" = stats.haiku_errors > 0 ? "partial" : "ok";
    await supabaseService.from("runs").insert({
      kind: "job_classify",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status,
      stats,
    });

    return { kind: "job_classify", status, stats, duration_ms: Date.now() - t0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabaseService.from("runs").insert({
      kind: "job_classify",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "error",
      stats,
      error: message,
    });
    return { kind: "job_classify", status: "error", stats, error: message, duration_ms: Date.now() - t0 };
  }
}
