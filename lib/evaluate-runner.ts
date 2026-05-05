import { supabaseService } from "./supabase";
import { evaluateCompany, EVALUATION_VERSION } from "./evaluate-company";
import { writeCompanyEvaluations } from "./sheets";
import type { SheetEvaluation } from "./sheets";
import type { StepResult } from "./sync";

export type EvaluateStats = {
  candidates: number;
  evaluated: number;
  errors: number;
  by_tier: { A: number; B: number; C: number; Failed: number };
  evaluation_version: string;
  rows_written_to_sheet: number;
};

export async function runEvaluate(): Promise<StepResult<EvaluateStats>> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const stats: EvaluateStats = {
    candidates: 0,
    evaluated: 0,
    errors: 0,
    by_tier: { A: 0, B: 0, C: 0, Failed: 0 },
    evaluation_version: EVALUATION_VERSION,
    rows_written_to_sheet: 0,
  };

  try {
    const { data: companies, error } = await supabaseService
      .from("companies")
      .select("id, name, careers_url, notes, evaluation_version, tier");
    if (error) throw error;

    const todo = (companies ?? []).filter(
      (c) => c.evaluation_version !== EVALUATION_VERSION,
    );
    stats.candidates = todo.length;

    const sheetUpdates = new Map<string, SheetEvaluation>();

    for (const c of todo) {
      // If the user has pre-set a tier (override), don't re-evaluate — just stamp the version.
      if (c.tier && ["A", "B", "C", "Failed"].includes(c.tier as string)) {
        const { error: stampErr } = await supabaseService
          .from("companies")
          .update({
            evaluation_version: EVALUATION_VERSION,
            evaluated_at: new Date().toISOString(),
          })
          .eq("id", c.id);
        if (stampErr) {
          stats.errors++;
          continue;
        }
        stats.evaluated++;
        stats.by_tier[c.tier as keyof typeof stats.by_tier]++;
        console.log(`  ${c.name}: ${c.tier} (user override, no LLM call)`);
        continue;
      }
      try {
        const result = await evaluateCompany({
          name: c.name as string,
          careers_url: (c.careers_url as string | null) ?? null,
          notes: (c.notes as string | null) ?? null,
        });
        stats.evaluated++;
        stats.by_tier[result.tier]++;

        const { error: upErr } = await supabaseService
          .from("companies")
          .update({
            ai_deployment_score: result.ai_deployment_score,
            team_caliber_score: result.team_caliber_score,
            customer_access_score: result.customer_access_score,
            network_alumni_score: result.network_alumni_score,
            stage_score: result.stage_score,
            mission_score: result.mission_score,
            tier: result.tier,
            tier_reasoning: result.reasoning,
            evaluation_version: EVALUATION_VERSION,
            evaluated_at: new Date().toISOString(),
          })
          .eq("id", c.id);
        if (upErr) throw upErr;

        sheetUpdates.set(c.name as string, {
          _tier: result.tier,
          _tier_reasoning: result.reasoning,
          ai_deployment_score: result.ai_deployment_score,
          team_caliber_score: result.team_caliber_score,
          customer_access_score: result.customer_access_score,
          network_alumni_score: result.network_alumni_score,
          stage_score: result.stage_score,
          mission_score: result.mission_score,
        });
        console.log(`  ${c.name}: ${result.tier} — ${result.reasoning}`);
      } catch (e) {
        stats.errors++;
        console.warn(`  ${c.name}: ERROR ${e instanceof Error ? e.message : e}`);
      }
    }

    if (sheetUpdates.size > 0) {
      const written = await writeCompanyEvaluations(sheetUpdates);
      stats.rows_written_to_sheet = written;
    }

    const status: "ok" | "partial" | "error" =
      stats.errors > 0 ? (stats.evaluated > 0 ? "partial" : "error") : "ok";

    await supabaseService.from("runs").insert({
      kind: "company_evaluate",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status,
      stats,
    });

    return { kind: "company_evaluate", status, stats, duration_ms: Date.now() - t0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabaseService.from("runs").insert({
      kind: "company_evaluate",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "error",
      stats,
      error: message,
    });
    return { kind: "company_evaluate", status: "error", stats, error: message, duration_ms: Date.now() - t0 };
  }
}
