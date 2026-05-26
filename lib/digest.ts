import { Resend } from "resend";
import { supabaseService } from "./supabase";
import { appendJobsRows, readJobsTabSnapshot, updateJobRowFields } from "./sheets";
import type { JobsRowValues, JobRowFieldUpdate } from "./sheets";
import type { StepResult } from "./sync";

const MIN_MATCH_SCORE = 0.6;
const DEFAULT_FROM = "Vouch <onboarding@resend.dev>";

export type DigestStats = {
  matches_to_sync: number;
  rows_appended_to_sheet: number;
  is_open_cells_refreshed: number;
  category_cells_refreshed: number;
  priority_cells_refreshed: number;
  marked_synced: number;
  email_sent: boolean;
  email_skipped_reason: string | null;
  recipient: string | null;
  resend_id: string | null;
};

type ContactRow = {
  name: string;
  role: string | null;
  relationship_strength: string | null;
  contact_method: string | null;
};

type MatchRow = {
  job_match_id: string;
  match_score: number;
  matched_role_category: string;
  classification_reasoning: string | null;
  job: {
    id: string;
    title: string;
    location: string | null;
    url: string;
    company_id: string;
    posted_at: string | null;
    first_seen_at: string | null;
  };
  company: {
    name: string;
    contacts: ContactRow[];
  };
};

function pickOne<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

async function fetchUnsynced(): Promise<MatchRow[]> {
  const { data, error } = await supabaseService
    .from("job_matches")
    .select(
      `id,
       match_score,
       matched_role_category,
       classification_reasoning,
       jobs!inner(
         id,
         title,
         location,
         url,
         company_id,
         posted_at,
         first_seen_at,
         is_open,
         companies!inner(
           name,
           contacts(name, role, relationship_strength, contact_method)
         )
       )`,
    )
    .is("synced_to_sheet_at", null)
    .neq("matched_role_category", "none")
    .gte("match_score", MIN_MATCH_SCORE)
    .eq("status", "new");
  if (error) throw error;

  const out: MatchRow[] = [];
  for (const raw of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const job = pickOne(raw.jobs as unknown);
    if (!job || !(job as { is_open?: boolean }).is_open) continue;
    const j = job as Record<string, unknown>;
    const company = pickOne(j.companies as unknown);
    if (!company) continue;
    const co = company as Record<string, unknown>;
    out.push({
      job_match_id: raw.id as string,
      match_score: Number(raw.match_score ?? 0),
      matched_role_category: String(raw.matched_role_category ?? ""),
      classification_reasoning: (raw.classification_reasoning as string | null) ?? null,
      job: {
        id: j.id as string,
        title: j.title as string,
        location: (j.location as string | null) ?? null,
        url: j.url as string,
        company_id: j.company_id as string,
        posted_at: (j.posted_at as string | null) ?? null,
        first_seen_at: (j.first_seen_at as string | null) ?? null,
      },
      company: {
        name: co.name as string,
        contacts: ((co.contacts as ContactRow[] | null) ?? []),
      },
    });
  }
  return out;
}

const CATEGORY_LABEL: Record<string, string> = {
  pm: "PM",
  ds_fde: "DS / FDE",
  tpm: "TPM",
  program_mgr: "Program Mgr",
};

function dateForSheet(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10); // YYYY-MM-DD
}

function escapeForFormula(s: string): string {
  return s.replace(/"/g, '""');
}

// Build the structured field→value record for one match. The Referee and
// Days Listed formulas, and the placement of every field, are injected by
// appendJobsRows based on the live header row — see lib/sheets.ts.
function toJobsRow(m: MatchRow, isOpen: boolean): JobsRowValues {
  return {
    title: `=HYPERLINK("${escapeForFormula(m.job.url)}", "${escapeForFormula(m.job.title)}")`,
    date: dateForSheet(m.job.posted_at ?? m.job.first_seen_at),
    is_open: isOpen ? "TRUE" : "FALSE",
    category: CATEGORY_LABEL[m.matched_role_category] ?? m.matched_role_category,
    company: m.company.name,
    location: m.job.location ?? "",
    priority: m.match_score.toFixed(2),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function composeHtml(matches: MatchRow[]): string {
  if (!matches.length) return "<p>No new matches.</p>";

  const byCompany = new Map<string, { name: string; contacts: ContactRow[]; rows: MatchRow[] }>();
  for (const m of matches) {
    const entry = byCompany.get(m.job.company_id);
    if (entry) entry.rows.push(m);
    else byCompany.set(m.job.company_id, { name: m.company.name, contacts: m.company.contacts, rows: [m] });
  }
  const ordered = Array.from(byCompany.values()).sort((a, b) => {
    if (a.contacts.length !== b.contacts.length) return b.contacts.length - a.contacts.length;
    return a.name.localeCompare(b.name);
  });

  const sections = ordered
    .map((c) => {
      const jobs = c.rows
        .sort((a, b) => b.match_score - a.match_score)
        .map((m) => {
          const loc = m.job.location ? ` &middot; <span style="color:#666">${escapeHtml(m.job.location)}</span>` : "";
          const cat = `<span style="color:#888;font-size:12px">[${escapeHtml(CATEGORY_LABEL[m.matched_role_category] ?? m.matched_role_category)} @ ${m.match_score.toFixed(2)}]</span>`;
          const reason = m.classification_reasoning
            ? `<div style="color:#666;font-size:12px;margin-left:18px;margin-top:2px">${escapeHtml(m.classification_reasoning)}</div>`
            : "";
          return `<li style="margin-bottom:8px"><a href="${escapeHtml(m.job.url)}">${escapeHtml(m.job.title)}</a> ${cat}${loc}${reason}</li>`;
        })
        .join("\n");

      const contactsBlock = c.contacts.length
        ? `<p style="margin:6px 0 12px 0;font-size:14px;color:#444"><strong>People you know:</strong> ${c.contacts
            .map((ct) => {
              const parts = [escapeHtml(ct.name)];
              if (ct.role) parts.push(escapeHtml(ct.role));
              if (ct.relationship_strength) parts.push(`<em>${escapeHtml(ct.relationship_strength)}</em>`);
              if (ct.contact_method) parts.push(`<code>${escapeHtml(ct.contact_method)}</code>`);
              return parts.join(" &middot; ");
            })
            .join(" &middot; ")}</p>`
        : `<p style="margin:6px 0 12px 0;font-size:14px;color:#999">No contacts yet at this company.</p>`;

      return `<section style="margin:24px 0">
  <h2 style="margin:0 0 4px 0">${escapeHtml(c.name)} <span style="color:#666;font-weight:normal;font-size:14px">(${c.rows.length} match${c.rows.length === 1 ? "" : "es"})</span></h2>
  ${contactsBlock}
  <ul style="padding-left:20px;margin:0">${jobs}</ul>
</section>`;
    })
    .join("\n");

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width:680px; margin:0 auto; padding:16px">
  <p style="color:#666;font-size:13px;margin:0 0 8px 0">${matches.length} new match${matches.length === 1 ? "" : "es"} across ${ordered.length} compan${ordered.length === 1 ? "y" : "ies"}. Already added to your <strong>Jobs</strong> tab in the Vouch sheet.</p>
  ${sections}
  <hr style="margin-top:32px;border:none;border-top:1px solid #eee">
  <p style="color:#999;font-size:11px">Vouch daily digest. Triage in the Jobs tab; tweak excludes/locations to refine future runs.</p>
</div>`;
}

async function refreshSyncedRowsInSheet(): Promise<{ is_open: number; category: number; priority: number }> {
  const snapshot = await readJobsTabSnapshot();
  if (snapshot.length === 0) return { is_open: 0, category: 0, priority: 0 };
  const urls = snapshot.map((r) => r.url);

  // Pull current is_open + match category/score per URL via a join through jobs → job_matches.
  // Chunk by cumulative ENCODED length, not a fixed count: a PostgREST `.in("url", [...])`
  // filter is sent in the request URL, and undici caps total headers at ~16KB. Long ATS
  // URLs (Greenhouse/Ashby ~80-120 chars, ~2-3x when percent-encoded) mean a fixed count
  // of 200 overflows once the sheet grows past ~200 rows. Budget the in-clause to ~8KB.
  type DbState = { is_open: boolean; category: string | null; score: number | null };
  const dbState = new Map<string, DbState>();
  const IN_CLAUSE_BUDGET = 8000;
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const url of urls) {
    const encodedLen = encodeURIComponent(url).length + 3; // quotes + comma separator
    if (current.length && currentLen + encodedLen > IN_CLAUSE_BUDGET) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(url);
    currentLen += encodedLen;
  }
  if (current.length) chunks.push(current);

  for (const chunk of chunks) {
    const { data, error } = await supabaseService
      .from("jobs")
      .select("url, is_open, job_matches(matched_role_category, match_score)")
      .in("url", chunk);
    if (error) throw error;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const matches = Array.isArray(r.job_matches)
        ? (r.job_matches as Array<Record<string, unknown>>)
        : r.job_matches
          ? [r.job_matches as Record<string, unknown>]
          : [];
      const m = matches[0];
      dbState.set(r.url as string, {
        is_open: r.is_open as boolean,
        category: (m?.matched_role_category as string | null) ?? null,
        score: (m?.match_score as number | null) ?? null,
      });
    }
  }

  const labelMap: Record<string, string> = {
    pm: "PM",
    ds_fde: "DS / FDE",
    tpm: "TPM",
    program_mgr: "Program Mgr",
    none: "(reclassified out)",
  };

  const updates: JobRowFieldUpdate[] = [];
  let isOpenChanged = 0;
  let catChanged = 0;
  let prioChanged = 0;

  for (const row of snapshot) {
    const db = dbState.get(row.url);
    if (!db) continue; // URL not in DB (likely a row the user added manually)

    const update: JobRowFieldUpdate = { rowIndex: row.rowIndex };

    // Is_Open
    const wantIsOpen = db.is_open ? "TRUE" : "FALSE";
    if (row.isOpen.toUpperCase() !== wantIsOpen) {
      update.isOpen = db.is_open;
      isOpenChanged++;
    }

    // Category — show friendly label, including "(reclassified out)" for jobs flipped to "none" after re-eval
    if (db.category) {
      const wantCat = labelMap[db.category] ?? db.category;
      if (row.category !== wantCat) {
        update.category = wantCat;
        catChanged++;
      }
    }

    // Priority — round to 2 decimals so we don't false-flag 0.95 vs 0.9500001
    if (db.score !== null) {
      const wantPriority = db.score.toFixed(2);
      if (row.priority !== wantPriority) {
        update.priority = wantPriority;
        prioChanged++;
      }
    }

    if (update.isOpen !== undefined || update.category !== undefined || update.priority !== undefined) {
      updates.push(update);
    }
  }

  await updateJobRowFields(updates);
  return { is_open: isOpenChanged, category: catChanged, priority: prioChanged };
}

export async function runDigest(): Promise<StepResult<DigestStats>> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const recipient = process.env.DIGEST_TO_EMAIL ?? null;
  const fromAddress = process.env.DIGEST_FROM_EMAIL ?? DEFAULT_FROM;

  const stats: DigestStats = {
    matches_to_sync: 0,
    rows_appended_to_sheet: 0,
    is_open_cells_refreshed: 0,
    category_cells_refreshed: 0,
    priority_cells_refreshed: 0,
    marked_synced: 0,
    email_sent: false,
    email_skipped_reason: null,
    recipient,
    resend_id: null,
  };

  try {
    if (!recipient) throw new Error("DIGEST_TO_EMAIL is not set");
    if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");

    // Step 1: refresh existing synced rows — Is_Open / Category / Priority track DB state
    const refreshed = await refreshSyncedRowsInSheet();
    stats.is_open_cells_refreshed = refreshed.is_open;
    stats.category_cells_refreshed = refreshed.category;
    stats.priority_cells_refreshed = refreshed.priority;

    const matches = await fetchUnsynced();
    stats.matches_to_sync = matches.length;

    if (matches.length === 0) {
      stats.email_skipped_reason = "no_new_matches";
      await supabaseService.from("runs").insert({
        kind: "digest_email",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status: "ok",
        stats,
      });
      return { kind: "digest_email", status: "ok", stats, duration_ms: Date.now() - t0 };
    }

    // 1) Sort newest-first by posted_at (or first_seen_at as fallback) so the sheet stays scannable
    matches.sort((a, b) => {
      const ad = a.job.posted_at ?? a.job.first_seen_at ?? "";
      const bd = b.job.posted_at ?? b.job.first_seen_at ?? "";
      return bd.localeCompare(ad);
    });

    // 2) Append to sheet (all matches reaching this point are is_open=true per fetchUnsynced filter)
    const rows = matches.map((m) => toJobsRow(m, true));
    await appendJobsRows(rows);
    stats.rows_appended_to_sheet = rows.length;

    // 3) Mark synced (only after sheet append succeeded)
    const now = new Date().toISOString();
    const ids = matches.map((m) => m.job_match_id);
    const { error: updErr } = await supabaseService
      .from("job_matches")
      .update({ synced_to_sheet_at: now })
      .in("id", ids);
    if (updErr) throw updErr;
    stats.marked_synced = ids.length;

    // 4) Send email
    const subject = `Vouch: ${matches.length} new match${matches.length === 1 ? "" : "es"}`;
    const html = composeHtml(matches);
    const resend = new Resend(process.env.RESEND_API_KEY);
    const sendResult = await resend.emails.send({
      from: fromAddress,
      to: recipient,
      subject,
      html,
    });
    if (sendResult.error) throw new Error(`resend: ${sendResult.error.message}`);
    stats.email_sent = true;
    stats.resend_id = sendResult.data?.id ?? null;

    await supabaseService.from("runs").insert({
      kind: "digest_email",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "ok",
      stats,
    });
    return { kind: "digest_email", status: "ok", stats, duration_ms: Date.now() - t0 };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : JSON.stringify(err);
    await supabaseService.from("runs").insert({
      kind: "digest_email",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "error",
      stats,
      error: message,
    });
    return { kind: "digest_email", status: "error", stats, error: message, duration_ms: Date.now() - t0 };
  }
}
