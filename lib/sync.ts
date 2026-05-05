import { supabaseService } from "./supabase";
import { readCompanies, readContacts } from "./sheets";

export type SyncStats = {
  companies_upserted: number;
  contacts_upserted: number;
  contacts_deleted: number;
  contacts_skipped_unknown_company: number;
};

export type StepResult<S> = {
  kind: string;
  status: "ok" | "error" | "partial";
  stats: S;
  error?: string;
  duration_ms: number;
};

export async function runSync(): Promise<StepResult<SyncStats>> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const stats: SyncStats = {
    companies_upserted: 0,
    contacts_upserted: 0,
    contacts_deleted: 0,
    contacts_skipped_unknown_company: 0,
  };

  try {
    const [sheetCompanies, sheetContacts] = await Promise.all([
      readCompanies(),
      readContacts(),
    ]);

    if (sheetCompanies.length) {
      const now = new Date().toISOString();
      const rawPayload = sheetCompanies.map((c) => ({
        name: c.name,
        careers_url: c.careers_url,
        tier: c.tier,
        notes: c.notes,
        last_synced_at: now,
      }));
      // Deduplicate by name — last row wins if sheet has duplicates
      const payload = [...new Map(rawPayload.map((c) => [c.name, c])).values()];
      const { error, count } = await supabaseService
        .from("companies")
        .upsert(payload, { onConflict: "name", count: "exact" })
        .select("id");
      if (error) throw error;
      stats.companies_upserted = count ?? payload.length;
    }

    const { data: companyRows, error: companyErr } = await supabaseService
      .from("companies")
      .select("id, name");
    if (companyErr) throw companyErr;
    const companyIdByName = new Map(companyRows!.map((r) => [r.name, r.id as string]));

    const contactsToUpsert: Array<{
      company_id: string;
      name: string;
      role: string | null;
      relationship_strength: string | null;
      contact_method: string | null;
      notes: string | null;
    }> = [];
    for (const c of sheetContacts) {
      const company_id = companyIdByName.get(c.company_name);
      if (!company_id) {
        console.warn(
          `skipping contact "${c.name}": unknown company "${c.company_name}" (typo? add the company first)`,
        );
        stats.contacts_skipped_unknown_company++;
        continue;
      }
      const { company_name: _ignored, ...rest } = c;
      contactsToUpsert.push({ company_id, ...rest });
    }

    // Deduplicate by (company_id, name) — last row wins if sheet has duplicates
    const deduped = [
      ...new Map(contactsToUpsert.map((c) => [`${c.company_id}:${c.name}`, c])).values(),
    ];
    if (deduped.length) {
      const { error, count } = await supabaseService
        .from("contacts")
        .upsert(deduped, { onConflict: "company_id,name", count: "exact" })
        .select("id");
      if (error) throw error;
      stats.contacts_upserted = count ?? deduped.length;
    }

    const sheetKeys = new Set(deduped.map((c) => `${c.company_id}:${c.name}`));
    const { data: dbContacts, error: dbErr } = await supabaseService
      .from("contacts")
      .select("id, company_id, name");
    if (dbErr) throw dbErr;
    const toDelete = dbContacts!.filter((c) => !sheetKeys.has(`${c.company_id}:${c.name}`));
    if (toDelete.length) {
      const { error } = await supabaseService
        .from("contacts")
        .delete()
        .in("id", toDelete.map((c) => c.id));
      if (error) throw error;
      stats.contacts_deleted = toDelete.length;
    }

    await supabaseService.from("runs").insert({
      kind: "sheet_sync",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "ok",
      stats,
    });

    return { kind: "sheet_sync", status: "ok", stats, duration_ms: Date.now() - t0 };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : JSON.stringify(err);
    await supabaseService.from("runs").insert({
      kind: "sheet_sync",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "error",
      stats,
      error: message,
    });
    return { kind: "sheet_sync", status: "error", stats, error: message, duration_ms: Date.now() - t0 };
  }
}
