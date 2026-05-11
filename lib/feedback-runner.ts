import { supabaseService } from "./supabase";
import { readJobsFeedback, ensureFeedbackHeaders } from "./sheets";
import type { StepResult } from "./sync";

export type FeedbackStats = {
  headers_written: boolean;
  sheet_rows_with_feedback: number;
  upserted: number;
  skipped_unknown_url: number;
};

export async function runFeedback(): Promise<StepResult<FeedbackStats>> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const stats: FeedbackStats = {
    headers_written: false,
    sheet_rows_with_feedback: 0,
    upserted: 0,
    skipped_unknown_url: 0,
  };

  try {
    // One-time: write column K/L headers if missing
    const headerResult = await ensureFeedbackHeaders();
    stats.headers_written = headerResult.written;

    const feedback = await readJobsFeedback();
    stats.sheet_rows_with_feedback = feedback.length;
    if (!feedback.length) {
      await supabaseService.from("runs").insert({
        kind: "feedback_sync",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status: "ok",
        stats,
      });
      return { kind: "feedback_sync", status: "ok", stats, duration_ms: Date.now() - t0 };
    }

    // Map URL → job_id (chunk to avoid massive IN clauses)
    const urls = feedback.map((f) => f.url);
    const urlToJob = new Map<string, string>();
    const chunkSize = 200;
    for (let i = 0; i < urls.length; i += chunkSize) {
      const chunk = urls.slice(i, i + chunkSize);
      const { data, error } = await supabaseService
        .from("jobs")
        .select("id, url")
        .in("url", chunk);
      if (error) throw error;
      for (const j of data ?? []) urlToJob.set(j.url as string, j.id as string);
    }

    // Snapshot the current classification (so feedback survives reclassification)
    const jobIds = [...urlToJob.values()];
    type SnapRow = {
      job_id: string;
      matched_role_category: string | null;
      match_score: number | null;
      classification_reasoning: string | null;
    };
    const snapByJob = new Map<string, SnapRow>();
    if (jobIds.length) {
      const { data: matches, error: mErr } = await supabaseService
        .from("job_matches")
        .select("job_id, matched_role_category, match_score, classification_reasoning")
        .in("job_id", jobIds);
      if (mErr) throw mErr;
      for (const r of (matches ?? []) as SnapRow[]) snapByJob.set(r.job_id, r);
    }

    const now = new Date().toISOString();
    const upserts = [];
    for (const f of feedback) {
      const job_id = urlToJob.get(f.url);
      if (!job_id) {
        stats.skipped_unknown_url++;
        continue;
      }
      const snap = snapByJob.get(job_id);
      upserts.push({
        job_id,
        feedback: f.feedback,
        feedback_reason: f.feedback_reason,
        category_at_feedback: snap?.matched_role_category ?? null,
        score_at_feedback: snap?.match_score ?? null,
        reasoning_at_feedback: snap?.classification_reasoning ?? null,
        updated_at: now,
      });
    }

    if (upserts.length) {
      const { error: upErr } = await supabaseService
        .from("job_feedback")
        .upsert(upserts, { onConflict: "job_id" });
      if (upErr) {
        // Migration 0004 not yet applied — keep the rest of the pipeline green
        if (
          upErr.message?.toLowerCase().includes("does not exist") ||
          (upErr as { code?: string }).code === "42P01"
        ) {
          console.warn(
            `[feedback] job_feedback table missing — apply migration 0004_job_feedback.sql to enable feedback loop`,
          );
          await supabaseService.from("runs").insert({
            kind: "feedback_sync",
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            status: "ok",
            stats: { ...stats, table_missing: true },
          });
          return { kind: "feedback_sync", status: "ok", stats, duration_ms: Date.now() - t0 };
        }
        throw upErr;
      }
      stats.upserted = upserts.length;
    }

    await supabaseService.from("runs").insert({
      kind: "feedback_sync",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "ok",
      stats,
    });
    return { kind: "feedback_sync", status: "ok", stats, duration_ms: Date.now() - t0 };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : JSON.stringify(err);
    await supabaseService.from("runs").insert({
      kind: "feedback_sync",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "error",
      stats,
      error: message,
    });
    return { kind: "feedback_sync", status: "error", stats, error: message, duration_ms: Date.now() - t0 };
  }
}
