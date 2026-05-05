import "../lib/env";
import { google } from "googleapis";
import { supabaseService } from "../lib/supabase";

// Rebuild rows 2-N of the Companies tab cleanly from the DB. The user's banner
// in row 1 is preserved. Row 2 gets the user's preferred header order. Rows 3+
// get the data, restored from DB (where everything is intact — sync ran before
// the buggy evaluate-writer ran, so DB still has original careers_url + notes).

const HEADERS = [
  "Name",                                                        // A
  "Careers_url",                                                 // B
  "Priority (A, B, C, Failed)",                                  // C
  "AI deployment career capital",                                // D
  "Team caliber in the function you'd join (weight: high)",      // E
  "Customer access (weight: high)",                              // F
  "Network / alumni outcomes (weight: medium)",                  // G
  "Stage and sustainability (weight: medium)",                   // H
  "Mission alignment (weight: low)",                             // I
  "Notes",                                                       // J
  "Tier Reasoning",                                              // K
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

  // Fetch all 24 companies from DB with everything we need to restore
  const { data, error } = await supabaseService
    .from("companies")
    .select(
      "name, careers_url, notes, ai_deployment_score, team_caliber_score, customer_access_score, network_alumni_score, stage_score, mission_score, tier, tier_reasoning",
    )
    .order("name", { ascending: true });
  if (error) throw error;
  if (!data?.length) {
    console.log("no companies in DB; nothing to do");
    return;
  }

  // Build the rows: header row + one row per company
  const rows: (string | number | null)[][] = [HEADERS];
  for (const c of data) {
    rows.push([
      c.name,
      c.careers_url ?? "",
      c.tier ?? "",
      c.ai_deployment_score ?? "",
      c.team_caliber_score ?? "",
      c.customer_access_score ?? "",
      c.network_alumni_score ?? "",
      c.stage_score ?? "",
      c.mission_score ?? "",
      c.notes ?? "",
      c.tier_reasoning ?? "",
    ]);
  }

  // Clear rows 2 onward to prevent stale leftovers if the previous count was higher
  await sheets.spreadsheets.values.clear({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
    range: "Companies!A2:Z1000",
  });

  // Write the new content starting at row 2
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
    range: `Companies!A2`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  console.log(`Companies tab rebuilt: 1 header row + ${data.length} company rows`);
  console.log(`Banner in row 1 was not touched.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
