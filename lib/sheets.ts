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

// Order matches the user's headers in the Jobs tab:
// Job Title | Date Listed | Is_Open | Category | Company | Referee | Location | Priority | Comments | Status
export type JobsTabRow = [
  string, // A: Job Title (HYPERLINK formula)
  string, // B: Date Listed
  string, // C: Is_Open ("TRUE" / "FALSE")
  string, // D: Category
  string, // E: Company
  string, // F: Referee
  string, // G: Location
  string, // H: Priority
  string, // I: Comments
  string, // J: Status
];

export async function appendJobsRows(rows: JobsTabRow[]): Promise<void> {
  if (!rows.length) return;
  const sheets = google.sheets({ version: "v4", auth: getAuth(true) });
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
    range: "Jobs!A:J",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
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
  // Column A as FORMULA so we can extract URL from HYPERLINK; columns C–H as values for Is_Open / Category / Priority.
  const [formulas, values] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
      range: "Jobs!A:A",
      valueRenderOption: "FORMULA",
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID!,
      range: "Jobs!C:H",
      valueRenderOption: "FORMATTED_VALUE",
    }),
  ]);
  const out: JobsTabSnapshot = [];
  const aRows = formulas.data.values ?? [];
  const colsRows = values.data.values ?? []; // index 0 = col C, 1 = D, 2 = E, 3 = F, 4 = G, 5 = H
  for (let i = 1; i < aRows.length; i++) {
    const formula = String(aRows[i]?.[0] ?? "");
    const m = formula.match(URL_FROM_HYPERLINK);
    if (!m) continue;
    const cells = colsRows[i] ?? [];
    out.push({
      rowIndex: i + 1,
      url: m[1],
      isOpen: String(cells[0] ?? "").trim(),
      category: String(cells[1] ?? "").trim(),
      priority: String(cells[5] ?? "").trim(),
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
  const data: Array<{ range: string; values: (string | number)[][] }> = [];
  for (const u of updates) {
    if (u.isOpen !== undefined) {
      data.push({ range: `Jobs!C${u.rowIndex}`, values: [[u.isOpen ? "TRUE" : "FALSE"]] });
    }
    if (u.category !== undefined) {
      data.push({ range: `Jobs!D${u.rowIndex}`, values: [[u.category]] });
    }
    if (u.priority !== undefined) {
      data.push({ range: `Jobs!H${u.rowIndex}`, values: [[u.priority]] });
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
