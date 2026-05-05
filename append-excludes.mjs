import { google } from "googleapis";

// Two new rows for the Excludes tab. Category "function" matches your existing convention.
const NEW_ROWS = [
  ["function", "\\bforward[\\s-]?deployed\\b", "TRUE", "Forward Deployed Software Engineer", "Forward Deployed roles — too engineering-heavy for the candidate's technical depth"],
  ["function", "\\bsoftware engineer\\b", "TRUE", "Senior Software Engineer", "Pure software engineering — too technical (catches Senior/Staff/Forward Deployed Software Engineer too)"],
];

const credentials = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, "base64").toString("utf8"));
const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });

await sheets.spreadsheets.values.append({
  spreadsheetId: process.env.GOOGLE_SHEETS_ID,
  range: "Excludes!A:E",
  valueInputOption: "RAW",
  insertDataOption: "INSERT_ROWS",
  requestBody: { values: NEW_ROWS },
});

console.log(`Appended ${NEW_ROWS.length} rows to Excludes tab.`);
