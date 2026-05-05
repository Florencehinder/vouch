import { supabaseService } from "./supabase";
import { detect, fetchJobs } from "./ats";
import type { AtsProvider } from "./ats";
import type { StepResult } from "./sync";

type CompanyRow = {
  id: string;
  name: string;
  careers_url: string | null;
  ats_provider: string | null;
  ats_slug: string | null;
  tier: string | null;
};

const TIERS_THAT_FETCH = new Set(["A", "B"]);

type PerCompanyResult =
  | { kind: "ok"; jobs_seen: number; jobs_closed: number }
  | { kind: "skipped"; reason: string };

const ADAPTABLE = new Set<AtsProvider>(["greenhouse", "lever", "ashby", "smartrecruiters"]);

export type DiscoverStats = {
  companies_attempted: number;
  companies_succeeded: number;
  companies_failed: number;
  companies_skipped: number;
  jobs_seen: number;
  jobs_closed: number;
  detect_resolved: number;
  detect_still_scrape: number;
};

async function detectAndPersist(): Promise<{ detected: number; still_scrape: number }> {
  const { data, error } = await supabaseService
    .from("companies")
    .select("id, name, careers_url, ats_provider")
    .or("ats_provider.is.null,ats_provider.eq.scrape");
  if (error) throw error;

  let detected = 0;
  let still_scrape = 0;
  for (const c of data ?? []) {
    if (!c.careers_url) continue;
    let result;
    try {
      result = await detect(c.careers_url);
    } catch (e) {
      console.log(`  detect ${c.name}: ERROR ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const { error: upErr } = await supabaseService
      .from("companies")
      .update({ ats_provider: result.provider, ats_slug: result.slug })
      .eq("id", c.id);
    if (upErr) throw upErr;
    if (result.provider === "scrape") still_scrape++;
    else detected++;
  }
  return { detected, still_scrape };
}

async function discoverForCompany(company: CompanyRow): Promise<PerCompanyResult> {
  if (!company.tier) return { kind: "skipped", reason: "tier:unevaluated" };
  if (!TIERS_THAT_FETCH.has(company.tier)) return { kind: "skipped", reason: `tier:${company.tier}` };
  const provider = company.ats_provider as AtsProvider | null;
  if (!provider) return { kind: "skipped", reason: "no provider (run detect first)" };
  if (!ADAPTABLE.has(provider)) return { kind: "skipped", reason: provider };
  if (!company.ats_slug) return { kind: "skipped", reason: "no slug" };

  const jobs = await fetchJobs(provider, company.ats_slug);
  const now = new Date().toISOString();

  if (jobs.length) {
    const rows = jobs.map((j) => ({
      company_id: company.id,
      external_id: j.external_id,
      title: j.title,
      location: j.location,
      url: j.url,
      description_text: j.description_text,
      posted_at: j.posted_at?.toISOString() ?? null,
      last_seen_at: now,
      is_open: true,
    }));
    const { error } = await supabaseService
      .from("jobs")
      .upsert(rows, { onConflict: "company_id,external_id" });
    if (error) throw error;
  }

  const { data: existing, error: existErr } = await supabaseService
    .from("jobs")
    .select("id, external_id")
    .eq("company_id", company.id)
    .eq("is_open", true);
  if (existErr) throw existErr;

  const seen = new Set(jobs.map((j) => j.external_id));
  const toClose = (existing ?? []).filter((j) => !seen.has(j.external_id)).map((j) => j.id);
  let jobs_closed = 0;
  if (toClose.length) {
    const { error } = await supabaseService.from("jobs").update({ is_open: false }).in("id", toClose);
    if (error) throw error;
    jobs_closed = toClose.length;
  }

  await supabaseService.from("companies").update({ last_scraped_at: now }).eq("id", company.id);

  return { kind: "ok", jobs_seen: jobs.length, jobs_closed };
}

export async function runDiscover(): Promise<StepResult<DiscoverStats>> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const stats: DiscoverStats = {
    companies_attempted: 0,
    companies_succeeded: 0,
    companies_failed: 0,
    companies_skipped: 0,
    jobs_seen: 0,
    jobs_closed: 0,
    detect_resolved: 0,
    detect_still_scrape: 0,
  };

  try {
    const detectStats = await detectAndPersist();
    stats.detect_resolved = detectStats.detected;
    stats.detect_still_scrape = detectStats.still_scrape;

    const { data: companies, error } = await supabaseService
      .from("companies")
      .select("id, name, careers_url, ats_provider, ats_slug, tier");
    if (error) throw error;

    for (const c of companies ?? []) {
      stats.companies_attempted++;
      try {
        const result = await discoverForCompany(c as CompanyRow);
        if (result.kind === "skipped") {
          stats.companies_skipped++;
        } else {
          stats.companies_succeeded++;
          stats.jobs_seen += result.jobs_seen;
          stats.jobs_closed += result.jobs_closed;
        }
      } catch (e) {
        stats.companies_failed++;
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`  ${c.name}: ERROR ${msg}`);
      }
    }

    const status: "ok" | "partial" | "error" =
      stats.companies_failed > 0
        ? stats.companies_succeeded > 0
          ? "partial"
          : "error"
        : "ok";

    await supabaseService.from("runs").insert({
      kind: "job_discover",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status,
      stats,
    });

    return { kind: "job_discover", status, stats, duration_ms: Date.now() - t0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabaseService.from("runs").insert({
      kind: "job_discover",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "error",
      stats,
      error: message,
    });
    return { kind: "job_discover", status: "error", stats, error: message, duration_ms: Date.now() - t0 };
  }
}
