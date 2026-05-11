import "../lib/env";
import { google } from "googleapis";

const NEW_COMPANIES: Array<[string, string]> = [
  ["Baseten", "https://jobs.ashbyhq.com/baseten"],
  ["Fireworks AI", "https://job-boards.greenhouse.io/fireworksai"],
  ["Anyscale", "https://jobs.ashbyhq.com/anyscale"],
  ["Cartesia", "https://jobs.ashbyhq.com/cartesia"],
  ["Hebbia", "https://job-boards.greenhouse.io/hebbia"],
  ["The Browser Company", "https://jobs.ashbyhq.com/The%20Browser%20Company"],
  ["Hex Technologies", "https://job-boards.greenhouse.io/hextechnologies"],
  ["Factory", "https://jobs.ashbyhq.com/factory"],
  ["Arena", "https://job-boards.greenhouse.io/arenaphysica"],
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

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Companies!A:B",
  });
  const rows = res.data.values ?? [];
  const existingNames = new Set(
    rows.slice(1).map((r) => String(r[0] ?? "").trim().toLowerCase()).filter(Boolean),
  );

  const toAppend = NEW_COMPANIES.filter(
    ([name]) => !existingNames.has(name.toLowerCase()),
  );
  const skipped = NEW_COMPANIES.filter(([name]) => existingNames.has(name.toLowerCase()));

  if (skipped.length) {
    console.log(`skipping ${skipped.length} (already in sheet):`, skipped.map(([n]) => n).join(", "));
  }

  if (toAppend.length === 0) {
    console.log("nothing to append");
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Companies!A:B",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: toAppend },
  });

  console.log(`appended ${toAppend.length} rows:`);
  for (const [name, url] of toAppend) console.log(`  ${name} → ${url}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
