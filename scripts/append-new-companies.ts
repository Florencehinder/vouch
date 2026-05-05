import "../lib/env";
import { google } from "googleapis";

const NEW_COMPANIES: Array<[string, string]> = [
  ["Scale AI", "https://job-boards.greenhouse.io/scaleai"],
  ["Databricks", "https://job-boards.greenhouse.io/databricks"],
  ["Isomorphic Labs", "https://www.isomorphiclabs.com/job-openings"],
  ["Writer", "https://jobs.ashbyhq.com/writer"],
  ["Hume AI", "https://job-boards.greenhouse.io/humeai"],
  ["Poolside", "https://poolside.ai/careers"],
  ["H Company", "https://jobs.ashbyhq.com/hcompany"],
  ["Dust", "https://jobs.ashbyhq.com/dust"],
  ["Owkin", "https://www.owkin.com/careers"],
  ["Causaly", "https://www.causaly.com/careers"],
  ["Tessl", "https://jobs.ashbyhq.com/tesslcareers"],
  ["Tractable", "https://jobs.ashbyhq.com/tractable"],
  ["Hadean", "https://hadean.com/careers"],
  ["Multiverse", "https://www.multiverse.io/en-GB/careers"],
  ["Behavox", "https://www.behavox.com/careers"],
  ["MindFoundry", "https://www.mindfoundry.ai/about-us/careers"],
  ["Stability AI", "https://stability.ai/careers"],
  ["Cresta", "https://cresta.com/careers/"],
  ["Notion", "https://job-boards.greenhouse.io/notion"],
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
