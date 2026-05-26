import { google } from "googleapis";

export type CompanyRow = {
  name: string;
  careers_url: string | null;
  tier: string | null; // from sheet's "Priority (A, B, C, Failed)" column — user-controlled override
  notes: string | null;
};

export type ContactRow = {
  company_name: string;
  name: string;
  role: string | null;
  relationship_strength: string | null;
  contact_method: string | null;
  notes: string | null;
};

function getAuth(write = false) {
  const credentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!, "base64").toString("utf8"),
  );
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      write
        ? "https://www.googleapis.com/auth/spreadsheets"
        : "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });
}

// Find the 0-indexed row where the header lives. Looks for `expectedFirstHeader`
// in column A within the first 5 rows. Returns 0 if not found (matches the old
// "headers in row 1" default).
function findHeaderRowIdx(rows: unknown[][], expectedFirstHeader: string): number {
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const a = String(rows[i]?.[0] ?? "").trim().toLowerCase();
    if (a === expectedFirstHeader.toLowerCase()) return i;
  }
  return 0;
}

async function readTab(tab: string, expectedFirstHeader?: string): Promise<Record<string, string>[]> {
  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
    range: `${tab}!A:Z`,
  });
  const rows = res.data.values ?? [];
  const headerIdx = expectedFirstHeader ? findHeaderRowIdx(rows, expectedFirstHeader) : 0;
  if (rows.length < headerIdx + 2) return [];
  const headers = rows[headerIdx].map((h) => String(h).trim().toLowerCase());
  return rows.slice(headerIdx + 1).map((r) =>
    Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").toString().trim()])),
  );
}

const nullable = (s: string | undefined) => (s && s.length ? s : null);

export async function readCompanies(): Promise<CompanyRow[]> {
  const rows = await readTab("companies", "name");
  return rows
    .filter((r) => r.name)
    .map((r) => ({
      name: r.name,
      careers_url: nullable(r.careers_url),
      // The user's "Priority (A, B, C, Failed)" column carries the tier (user-overridable).
      // Fallback to a plain "priority" column if someone simplifies the header.
      tier: nullable(r["priority (a, b, c, failed)"] ?? r.priority),
      notes: nullable(r.notes),
    }));
}

export async function readContacts(): Promise<ContactRow[]> {
  const rows = await readTab("contacts", "company_name");
  return rows
    .filter((r) => r.company_name && r.name)
    .map((r) => ({
      company_name: r.company_name,
      name: r.name,
      role: nullable(r.role),
      relationship_strength: nullable(r.relationship_strength),
      contact_method: nullable(r.contact_method),
      notes: nullable(r.notes),
    }));
}

export type ExcludeRow = { category: string; pattern: string; enabled: boolean; notes: string | null };
export type LocationRow = { location: string; enabled: boolean; notes: string | null };

const isEnabled = (s: string | undefined) => {
  const v = (s ?? "").trim().toLowerCase();
  return v === "" || v === "true" || v === "yes" || v === "1";
};

async function readTabSafe(tab: string, expectedFirstHeader?: string): Promise<Record<string, string>[] | null> {
  try {
    return await readTab(tab, expectedFirstHeader);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Unable to parse range|not found/i.test(msg)) {
      console.warn(`  sheets: tab "${tab}" not found, treating as empty`);
      return null;
    }
    throw e;
  }
}

export async function readExcludes(): Promise<ExcludeRow[]> {
  const rows = await readTabSafe("excludes", "category");
  if (rows === null) return [];
  return rows
    .filter((r) => r.category && r.pattern)
    .map((r) => ({
      category: r.category,
      pattern: r.pattern,
      enabled: isEnabled(r.enabled),
      notes: nullable(r.notes),
    }));
}

export async function readLocations(): Promise<LocationRow[]> {
  const rows = await readTabSafe("locations", "location");
  if (rows === null) return [];
  return rows
    .filter((r) => r.location)
    .map((r) => ({
      location: r.location,
      enabled: isEnabled(r.enabled),
      notes: nullable(r.notes),
    }));
}

// === Jobs tab: header-driven column resolution ==============================
//
// The Jobs tab is the user's working surface — they reorder columns, insert
// new ones (e.g. "Days Listed"), and rename. We therefore NEVER address columns
// by fixed letter. Every read/write resolves the live header row first and maps
// each canonical field to whatever column currently carries that header. The
// header text is the single point of truth.

export type JobsField =
  | "title"
  | "date"
  | "days_listed"
  | "is_open"
  | "category"
  | "company"
  | "referee"
  | "location"
  | "priority"
  | "comments"
  | "status"
  | "feedback"
  | "feedback_reason";

// Matched against the normalized (trim + lowercase) header text. First matching
// column wins, so duplicate headers don't double-map. `priority`/`status` match
// by prefix because the user keeps descriptive suffixes
// ("Priority (CV & Career goal match)", "Status (Applied | Interested | Passed)").
const JOBS_FIELD_MATCHERS: Array<{ field: JobsField; match: (h: string) => boolean }> = [
  { field: "title", match: (h) => h === "job title" },
  { field: "date", match: (h) => h === "date listed" },
  { field: "days_listed", match: (h) => h === "days listed" },
  { field: "is_open", match: (h) => h === "is_open" },
  { field: "category", match: (h) => h === "category" },
  { field: "company", match: (h) => h === "company" },
  { field: "referee", match: (h) => h === "referee" },
  { field: "location", match: (h) => h === "location" },
  { field: "priority", match: (h) => h.startsWith("priority") },
  { field: "comments", match: (h) => h === "comments" },
  { field: "status", match: (h) => h.startsWith("status") },
  { field: "feedback", match: (h) => h === "feedback" },
  { field: "feedback_reason", match: (h) => h === "feedback_reason" },
];

type SheetsClient = ReturnType<typeof google.sheets>;

export type JobsColumns = {
  /** 0-based column index per resolved field. */
  index: Partial<Record<JobsField, number>>;
  /** Number of header cells in row 1 (defines the write width). */
  width: number;
};

async function resolveJobsColumns(sheets: SheetsClient): Promise<JobsColumns> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
    range: "Jobs!1:1",
  });
  const headers = (res.data.values?.[0] ?? []).map((h) => String(h).trim().toLowerCase());
  const index: Partial<Record<JobsField, number>> = {};
  headers.forEach((h, i) => {
    for (const m of JOBS_FIELD_MATCHERS) {
      if (index[m.field] === undefined && m.match(h)) {
        index[m.field] = i;
        break;
      }
    }
  });
  return { index, width: Math.max(headers.length, 1) };
}

// Build the row-relative Referee formula referencing whatever column holds Company.
function refereeFormula(cols: JobsColumns): string | null {
  const companyIdx = cols.index.company;
  if (companyIdx === undefined) return null;
  const c = colLetter(companyIdx);
  return `=IFNA(TEXTJOIN(", ", TRUE, FILTER(Contacts!B:B & " (" & Contacts!D:D & ")", Contacts!A:A=INDIRECT("${c}"&ROW()))), "")`;
}

// Build the row-relative Days-Listed formula referencing whatever column holds Date Listed.
function daysListedFormula(cols: JobsColumns): string | null {
  const dateIdx = cols.index.date;
  if (dateIdx === undefined) return null;
  const d = colLetter(dateIdx);
  return `=IF(INDIRECT("${d}"&ROW())="","",TODAY()-INDIRECT("${d}"&ROW()))`;
}

// Structured values for one Jobs row. The caller supplies data fields; this
// module injects the Referee + Days Listed formulas into their resolved columns.
export type JobsRowValues = {
  title: string; // HYPERLINK formula
  date: string;
  is_open: string; // "TRUE" / "FALSE"
  category: string;
  company: string;
  location: string;
  priority: string;
};

export async function appendJobsRows(rows: JobsRowValues[]): Promise<void> {
  if (!rows.length) return;
  const sheets = google.sheets({ version: "v4", auth: getAuth(true) });
  const cols = await resolveJobsColumns(sheets);
  const referee = refereeFormula(cols);
  const daysListed = daysListedFormula(cols);

  const values = rows.map((r) => {
    const arr: string[] = new Array(cols.width).fill("");
    const put = (field: JobsField, value: string | null) => {
      const i = cols.index[field];
      if (i !== undefined && value !== null) arr[i] = value;
    };
    put("title", r.title);
    put("date", r.date);
    put("days_listed", daysListed);
    put("is_open", r.is_open);
    put("category", r.category);
    put("company", r.company);
    put("referee", referee);
    put("location", r.location);
    put("priority", r.priority);
    return arr;
  });

  const lastCol = colLetter(cols.width - 1);
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
    range: `Jobs!A:${lastCol}`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

const URL_FROM_HYPERLINK = /^=HYPERLINK\("([^"]+)"/i;

export type JobsTabSnapshot = Array<{
  rowIndex: number;
  url: string;
  isOpen: string;
  category: string;
  priority: string;
}>;

export async function readJobsTabSnapshot(): Promise<JobsTabSnapshot> {
  const sheets = google.sheets({ version: "v4", auth: getAuth(true) });
  const cols = await resolveJobsColumns(sheets);
  // Whole grid as FORMULA so column A's HYPERLINK survives; everything else
  // reads fine as its formula/value too. Resolve fields by header position.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
    range: `Jobs!A:${colLetter(cols.width - 1)}`,
    valueRenderOption: "FORMULA",
  });
  const rows = res.data.values ?? [];
  const titleIdx = cols.index.title ?? 0;
  const at = (row: unknown[], field: JobsField): string => {
    const i = cols.index[field];
    return i === undefined ? "" : String(row[i] ?? "").trim();
  };
  const out: JobsTabSnapshot = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const formula = String(row[titleIdx] ?? "");
    const m = formula.match(URL_FROM_HYPERLINK);
    if (!m) continue;
    out.push({
      rowIndex: i + 1,
      url: m[1],
      isOpen: at(row, "is_open"),
      category: at(row, "category"),
      priority: at(row, "priority"),
    });
  }
  return out;
}

export type JobRowFieldUpdate = {
  rowIndex: number;
  isOpen?: boolean;
  category?: string;
  priority?: number | string;
};

export async function updateJobRowFields(updates: JobRowFieldUpdate[]): Promise<void> {
  if (!updates.length) return;
  const sheets = google.sheets({ version: "v4", auth: getAuth(true) });
  const cols = await resolveJobsColumns(sheets);
  const isOpenCol = cols.index.is_open;
  const categoryCol = cols.index.category;
  const priorityCol = cols.index.priority;
  const data: Array<{ range: string; values: (string | number)[][] }> = [];
  for (const u of updates) {
    if (u.isOpen !== undefined && isOpenCol !== undefined) {
      data.push({ range: `Jobs!${colLetter(isOpenCol)}${u.rowIndex}`, values: [[u.isOpen ? "TRUE" : "FALSE"]] });
    }
    if (u.category !== undefined && categoryCol !== undefined) {
      data.push({ range: `Jobs!${colLetter(categoryCol)}${u.rowIndex}`, values: [[u.category]] });
    }
    if (u.priority !== undefined && priorityCol !== undefined) {
      data.push({ range: `Jobs!${colLetter(priorityCol)}${u.rowIndex}`, values: [[u.priority]] });
    }
  }
  if (!data.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
    requestBody: { valueInputOption: "USER_ENTERED", data },
  });
}

// Back-compat shim for the old name, in case anything still imports it.
export async function updateJobsIsOpen(updates: Array<{ rowIndex: number; isOpen: boolean }>): Promise<void> {
  await updateJobRowFields(updates);
}

// === User feedback (sheet-only feedback loop) =================================
//
// The user maintains a "Feedback" column ('++' | '+' | '-' | '--') and an
// optional "Feedback_Reason" column in the Jobs tab. Both are resolved by
// header (not fixed position). classify.ts reads these to inject few-shot
// calibration examples into Haiku's prompt, pairing each with the row's
// current title/company/category/priority for context.

export type JobsFeedbackRow = {
  url: string;
  title: string;
  company: string;
  category: string | null;
  score: number | null;
  feedback: string;
  feedback_reason: string | null;
};

const VALID_FEEDBACK = new Set(["++", "+", "-", "--"]);
const TITLE_FROM_HYPERLINK = /^=HYPERLINK\("[^"]*",\s*"([^"]+)"/i;

// Ensure Feedback / Feedback_Reason columns exist. If missing, append them as
// NEW columns at the end of the header row (never overwrite existing columns by
// fixed position — that's what previously created duplicate headers).
export async function ensureFeedbackHeaders(): Promise<{ written: boolean }> {
  const sheets = google.sheets({ version: "v4", auth: getAuth(true) });
  const cols = await resolveJobsColumns(sheets);
  const missing: string[] = [];
  if (cols.index.feedback === undefined) missing.push("Feedback");
  if (cols.index.feedback_reason === undefined) missing.push("Feedback_Reason");
  if (missing.length === 0) return { written: false };
  const startCol = colLetter(cols.width);
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
    range: `Jobs!${startCol}1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [missing] },
  });
  return { written: true };
}

export async function readJobsFeedback(): Promise<JobsFeedbackRow[]> {
  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  const cols = await resolveJobsColumns(sheets);
  if (cols.index.feedback === undefined) return []; // no feedback column yet
  // Whole grid as FORMULA so column A's HYPERLINK (URL + title) is parseable.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
    range: `Jobs!A:${colLetter(cols.width - 1)}`,
    valueRenderOption: "FORMULA",
  });
  const rows = res.data.values ?? [];
  const titleIdx = cols.index.title ?? 0;
  const at = (row: unknown[], field: JobsField): string => {
    const i = cols.index[field];
    return i === undefined ? "" : String(row[i] ?? "").trim();
  };
  const out: JobsFeedbackRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const fbCell = at(row, "feedback");
    if (!fbCell || !VALID_FEEDBACK.has(fbCell)) continue; // skip blanks / typos
    const formula = String(row[titleIdx] ?? "");
    const urlM = formula.match(URL_FROM_HYPERLINK);
    if (!urlM) continue;
    const titleM = formula.match(TITLE_FROM_HYPERLINK);
    const priorityCell = at(row, "priority");
    const score = priorityCell ? Number(priorityCell) : null;
    out.push({
      url: urlM[1],
      title: titleM ? titleM[1] : "(unknown title)",
      company: at(row, "company"),
      category: at(row, "category") || null,
      score: Number.isFinite(score) ? score : null,
      feedback: fbCell,
      feedback_reason: at(row, "feedback_reason") || null,
    });
  }
  return out;
}

// Map between our DB field names and the user's preferred sheet column header.
// Used to find the correct column to write to. We never write to columns whose
// header is not in this map.
const HEADER_TO_DB_FIELD: Record<string, keyof SheetEvaluation | "_tier_reasoning"> = {
  "priority (a, b, c, failed)": "_tier",
  "ai deployment career capital": "ai_deployment_score",
  "team caliber in the function you'd join (weight: high)": "team_caliber_score",
  "team caliber in the function you'd join": "team_caliber_score",
  "customer access (weight: high)": "customer_access_score",
  "customer access": "customer_access_score",
  "network / alumni outcomes (weight: medium)": "network_alumni_score",
  "network / alumni outcomes": "network_alumni_score",
  "stage and sustainability (weight: medium)": "stage_score",
  "stage and sustainability": "stage_score",
  "mission alignment (weight: low)": "mission_score",
  "mission alignment": "mission_score",
  "tier reasoning": "_tier_reasoning",
};

export type SheetEvaluation = {
  _tier: string;
  _tier_reasoning: string;
  ai_deployment_score: number;
  team_caliber_score: number;
  customer_access_score: number;
  network_alumni_score: number;
  stage_score: number;
  mission_score: number;
};

function colLetter(zeroIdx: number): string {
  let n = zeroIdx;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

// Locate the row containing column-A == "name" (case-insensitive). The user has a banner
// row above the headers. Returns 1-based sheet row number, or null if not found in first 5 rows.
function findHeaderRow(rows: unknown[][]): number | null {
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const a = String(rows[i]?.[0] ?? "").trim().toLowerCase();
    if (a === "name") return i + 1;
  }
  return null;
}

export async function writeCompanyEvaluations(
  updates: Map<string, SheetEvaluation>,
): Promise<number> {
  if (updates.size === 0) return 0;
  const sheetsApi = google.sheets({ version: "v4", auth: getAuth(true) });

  const all = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
    range: "Companies!A:Z",
  });
  const rows = all.data.values ?? [];

  const headerRow = findHeaderRow(rows);
  if (headerRow === null) {
    throw new Error("Companies tab: header row not found (looked for 'Name' in column A in first 5 rows)");
  }
  const headers = (rows[headerRow - 1] ?? []).map((h) => String(h ?? "").trim().toLowerCase());

  // Build map: DB field → column index, by walking the user's headers
  const fieldToColIdx = new Map<string, number>();
  for (let i = 0; i < headers.length; i++) {
    const field = HEADER_TO_DB_FIELD[headers[i]];
    if (field) fieldToColIdx.set(field, i);
  }

  // Build map: company name → row index (1-based)
  const nameToRow = new Map<string, number>();
  for (let i = headerRow; i < rows.length; i++) {
    const name = String(rows[i]?.[0] ?? "").trim();
    if (name) nameToRow.set(name, i + 1);
  }

  const cellWrites: Array<{ range: string; values: (string | number)[][] }> = [];
  let written = 0;
  for (const [name, ev] of updates) {
    const sheetRow = nameToRow.get(name);
    if (sheetRow === undefined) continue;
    written++;
    for (const [field, colIdx] of fieldToColIdx) {
      const value = ev[field as keyof SheetEvaluation];
      if (value === undefined) continue;
      cellWrites.push({
        range: `Companies!${colLetter(colIdx)}${sheetRow}`,
        values: [[value as string | number]],
      });
    }
  }

  if (cellWrites.length) {
    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
      requestBody: { valueInputOption: "USER_ENTERED", data: cellWrites },
    });
  }

  return written;
}

// Companies tab: case-insensitive name lookup, write only when current cell is empty (don't overwrite user edits).
export async function updateMissingCareerUrls(updates: Map<string, string>): Promise<{ updated: number; skipped: number; not_found: string[] }> {
  if (updates.size === 0) return { updated: 0, skipped: 0, not_found: [] };
  const sheetsApi = google.sheets({ version: "v4", auth: getAuth(true) });

  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
    range: "Companies!A:Z",
  });
  const rows = res.data.values ?? [];

  const headerIdx = findHeaderRowIdx(rows, "name");
  if (rows.length < headerIdx + 2) return { updated: 0, skipped: 0, not_found: [...updates.keys()] };

  const headers = (rows[headerIdx] ?? []).map((h) => String(h).trim().toLowerCase());
  const nameCol = headers.indexOf("name");
  const urlCol = headers.indexOf("careers_url");
  if (nameCol < 0 || urlCol < 0) {
    throw new Error(`Companies tab missing required headers (name=${nameCol}, careers_url=${urlCol})`);
  }

  const writes: Array<{ range: string; values: string[][] }> = [];
  let skipped = 0;
  const found = new Set<string>();
  const urlColLetter = colLetter(urlCol);

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const name = String(rows[i]?.[nameCol] ?? "").trim();
    if (!name) continue;
    const wantUrl = updates.get(name) ?? updates.get(name.toLowerCase());
    if (!wantUrl) continue;
    found.add(name);
    const currentUrl = String(rows[i]?.[urlCol] ?? "").trim();
    if (currentUrl) {
      skipped++;
      continue;
    }
    writes.push({
      range: `Companies!${urlColLetter}${i + 1}`,
      values: [[wantUrl]],
    });
  }

  if (writes.length) {
    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
      requestBody: { valueInputOption: "USER_ENTERED", data: writes },
    });
  }

  const not_found = [...updates.keys()].filter((k) => !found.has(k));
  return { updated: writes.length, skipped, not_found };
}
