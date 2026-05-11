import "../lib/env";
import { google } from "googleapis";

// User speaks English and French only. Exclude jobs that explicitly require
// fluency in another language. Patterns target two common phrasings:
//   1. "<Lang> speaking|speaker|native|fluent|required|fluency|proficiency"
//      e.g. "Account Executive — German Speaking"
//   2. "(fluent|native|business-level|professional-level|C1|C2) in <Lang>"
//      e.g. "Fluent in Spanish required"
//
// Patterns are case-insensitive (filter.ts compiles with /i). Stored in the
// Excludes tab so the user can disable any row by flipping enabled to FALSE
// (e.g. if they later learn Spanish, just edit that row).

function build(altGroup: string): string {
  return `\\b${altGroup}[\\s-]?(speaking|speaker|native|fluent|required|fluency|proficiency)\\b|\\b(fluent|native|business[\\s-]?level|professional[\\s-]?level|c1|c2)\\s+(in\\s+)?${altGroup}\\b`;
}

const ROWS: Array<[string, string, string, string]> = [
  // category, pattern, enabled, example_match
  ["language", build("(german|deutsch)"), "TRUE", "Account Executive — German Speaking"],
  ["language", build("(spanish|castilian|español|espanol)"), "TRUE", "Customer Success Manager, Spanish-speaking"],
  ["language", build("(italian|italiano)"), "TRUE", "Native Italian required"],
  ["language", build("(portuguese|portugues|português|brazilian portuguese)"), "TRUE", "Fluent in Portuguese"],
  ["language", build("(dutch|nederlands|flemish)"), "TRUE", "Dutch-speaking Solutions Engineer"],
  ["language", build("(polish|polski)"), "TRUE", "Polish speaker preferred"],
  ["language", build("(swedish|norwegian|danish|finnish|nordic|scandinavian|svenska|norsk|dansk|suomi)"), "TRUE", "Nordic language fluency required"],
  ["language", build("(mandarin|cantonese|chinese)"), "TRUE", "Mandarin speaking AE"],
  ["language", build("(japanese|nihongo)"), "TRUE", "Native Japanese required"],
  ["language", build("(korean)"), "TRUE", "Korean-speaking PM"],
  ["language", build("(russian)"), "TRUE", "Fluent in Russian"],
  ["language", build("(czech|hungarian|romanian|ukrainian|bulgarian|slovak|slovenian|croatian|serbian)"), "TRUE", "Czech-speaking Account Manager"],
  ["language", build("(arabic)"), "TRUE", "Arabic-speaking required"],
  ["language", build("(turkish)"), "TRUE", "Turkish speaker"],
  ["language", build("(hebrew)"), "TRUE", "Hebrew fluency required"],
  ["language", build("(greek)"), "TRUE", "Greek-speaking Customer Success"],
];

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

  // Don't re-append if a "language" row already exists
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Excludes!A:B",
  });
  const existingPatterns = new Set(
    (existing.data.values ?? [])
      .slice(1)
      .filter((r) => String(r[0] ?? "").trim().toLowerCase() === "language")
      .map((r) => String(r[1] ?? "").trim()),
  );

  const toAppend = ROWS.filter(([, pattern]) => !existingPatterns.has(pattern));
  if (toAppend.length === 0) {
    console.log("All language excludes already present — nothing to append");
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Excludes!A:D",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: toAppend },
  });

  console.log(`Appended ${toAppend.length} language exclude rows:`);
  for (const [, , , example] of toAppend) console.log(`  ${example}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
