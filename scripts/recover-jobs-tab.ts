// One-off recovery for the Jobs tab after a column insertion ("Days Listed")
// shifted every row and the old fixed-position writes scrambled C–I.
//
// Strategy:
//   - Column A (HYPERLINK → URL + title) is the stable key; keep it.
//   - Rebuild Is_Open / Category / Company / Location / Priority / Date from the
//     DB, joined by URL.
//   - Preserve the user's manual columns: Comments, Status, Feedback,
//     Feedback_Reason (currently at sheet indices 9/10/11/12).
//   - Restore the canonical header row + the Referee and Days Listed formulas.
//
// Idempotent: safe to re-run (it always rebuilds from DB + current sheet state).

import "../lib/env";
import { google } from "googleapis";
import { supabaseService } from "../lib/supabase";

const CATEGORY_LABEL: Record<string, string> = {
  pm: "PM",
  ds_fde: "DS / FDE",
  tpm: "TPM",
  program_mgr: "Program Mgr",
};

// Canonical layout (A..M). Header text is the point of truth going forward.
const HEADERS = [
  "Job Title", // A
  "Date Listed", // B
  "Days Listed", // C
  "Is_Open", // D
  "Category", // E
  "Company", // F
  "Referee", // G
  "Location", // H
  "Priority (CV & Career goal match)", // I
  "Comments", // J
  "Status (Applied | Interested | Passed)", // K
  "Feedback", // L
  "Feedback_Reason", // M
];

// Formulas reference the canonical company (F) and date (B) columns.
const REFEREE_FORMULA =
  '=IFNA(TEXTJOIN(", ", TRUE, FILTER(Contacts!B:B & " (" & Contacts!D:D & ")", Contacts!A:A=INDIRECT("F"&ROW()))), "")';
const DAYS_LISTED_FORMULA = '=IF(INDIRECT("B"&ROW())="","",TODAY()-INDIRECT("B"&ROW()))';

const URL_FROM_HYPERLINK = /^=HYPERLINK\("([^"]+)"/i;

function dateForSheet(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10); // YYYY-MM-DD; Sheets coerces to a date serial
}

type DbState = {
  is_open: boolean;
  category: string | null;
  score: number | null;
  company: string | null;
  location: string | null;
  date: string | null;
};

async function main() {
  const credentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!, "base64").toString("utf8"),
  );
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID!;

  // 1. Read current grid as FORMULA (col A HYPERLINK + current manual cols)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Jobs!A1:M2000",
    valueRenderOption: "FORMULA",
  });
  const grid = res.data.values ?? [];
  const dataRows = grid.slice(1); // drop header row

  type SheetRow = {
    titleFormula: string;
    url: string | null;
    comments: string;
    status: string;
    feedback: string;
    feedbackReason: string;
  };
  const sheetRows: SheetRow[] = [];
  for (const row of dataRows) {
    const titleFormula = String(row[0] ?? "");
    if (!titleFormula.trim()) continue; // skip fully empty rows
    const m = titleFormula.match(URL_FROM_HYPERLINK);
    sheetRows.push({
      titleFormula,
      url: m ? m[1] : null,
      comments: String(row[9] ?? "").trim(), // current col J
      status: String(row[10] ?? "").trim(), // current col K
      feedback: String(row[11] ?? "").trim(), // current col L
      feedbackReason: String(row[12] ?? "").trim(), // current col M
    });
  }
  console.log(`Read ${sheetRows.length} data rows from sheet.`);

  // 2. Pull DB state for those URLs (length-aware chunking to avoid header overflow)
  const urls = sheetRows.map((r) => r.url).filter((u): u is string => !!u);
  const dbState = new Map<string, DbState>();
  let budget: string[] = [];
  let budgetLen = 0;
  const chunks: string[][] = [];
  for (const u of urls) {
    const enc = encodeURIComponent(u).length + 3;
    if (budget.length && budgetLen + enc > 8000) {
      chunks.push(budget);
      budget = [];
      budgetLen = 0;
    }
    budget.push(u);
    budgetLen += enc;
  }
  if (budget.length) chunks.push(budget);

  for (const chunk of chunks) {
    const { data, error } = await supabaseService
      .from("jobs")
      .select(
        "url, is_open, location, posted_at, first_seen_at, companies!inner(name), job_matches(matched_role_category, match_score)",
      )
      .in("url", chunk);
    if (error) throw error;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const co = Array.isArray(r.companies) ? r.companies[0] : r.companies;
      const matches = Array.isArray(r.job_matches)
        ? (r.job_matches as Array<Record<string, unknown>>)
        : r.job_matches
          ? [r.job_matches as Record<string, unknown>]
          : [];
      const match = matches[0];
      dbState.set(r.url as string, {
        is_open: r.is_open as boolean,
        category: (match?.matched_role_category as string | null) ?? null,
        score: (match?.match_score as number | null) ?? null,
        company: (co as { name?: string } | null)?.name ?? null,
        location: (r.location as string | null) ?? null,
        date: (r.posted_at as string | null) ?? (r.first_seen_at as string | null) ?? null,
      });
    }
  }
  console.log(`Matched ${dbState.size}/${urls.length} URLs to DB.`);

  // 3. Build canonical rows
  let missingFromDb = 0;
  const out: (string | number)[][] = [HEADERS];
  for (const sr of sheetRows) {
    const db = sr.url ? dbState.get(sr.url) : undefined;
    if (!db) missingFromDb++;
    const catLabel = db?.category ? (CATEGORY_LABEL[db.category] ?? db.category) : "";
    out.push([
      sr.titleFormula, // A: Job Title (keep)
      db ? dateForSheet(db.date) : "", // B: Date Listed (re-derived)
      DAYS_LISTED_FORMULA, // C: Days Listed
      db ? (db.is_open ? "TRUE" : "FALSE") : "", // D: Is_Open
      db && db.category && db.category !== "none" ? catLabel : "", // E: Category
      db?.company ?? "", // F: Company
      REFEREE_FORMULA, // G: Referee
      db?.location ?? "", // H: Location
      db?.score != null ? db.score.toFixed(2) : "", // I: Priority
      sr.comments, // J: Comments (preserved)
      sr.status, // K: Status (preserved)
      sr.feedback, // L: Feedback (preserved)
      sr.feedbackReason, // M: Feedback_Reason (preserved)
    ]);
  }

  // 4. Clear the old grid then write the rebuilt one
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: "Jobs!A1:Z2000" });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Jobs!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: out },
  });

  console.log(`Wrote ${out.length - 1} rebuilt rows + header.`);
  console.log(`  preserved comments: ${sheetRows.filter((r) => r.comments).length}`);
  console.log(`  preserved status:   ${sheetRows.filter((r) => r.status).length}`);
  console.log(`  preserved feedback: ${sheetRows.filter((r) => r.feedback).length}`);
  if (missingFromDb) console.log(`  ${missingFromDb} rows had URLs not in DB (DB-derived cells left blank).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
