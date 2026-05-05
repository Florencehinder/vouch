import { readExcludes, readLocations } from "./sheets";
import type { ExcludeRow, LocationRow } from "./sheets";

export type CompiledExclude = {
  category: string;
  pattern: string;
  regex: RegExp;
  notes: string | null;
};

export type FilterConfig = {
  excludes: CompiledExclude[];
  locations: string[];
};

export type FilterDecision =
  | { excluded: false }
  | { excluded: true; reason: string };

export async function loadFilterConfig(): Promise<FilterConfig> {
  const [excludeRows, locationRows] = await Promise.all([
    readExcludes(),
    readLocations(),
  ]);

  const excludes: CompiledExclude[] = [];
  for (const r of excludeRows) {
    if (!r.enabled) continue;
    try {
      excludes.push({
        category: r.category,
        pattern: r.pattern,
        regex: new RegExp(r.pattern, "i"),
        notes: r.notes,
      });
    } catch (e) {
      console.warn(
        `  filter: invalid regex for category "${r.category}": ${r.pattern} (${e instanceof Error ? e.message : e})`,
      );
    }
  }

  const locations = locationRows
    .filter((r) => r.enabled)
    .map((r) => r.location.toLowerCase());

  return { excludes, locations };
}

const DESCRIPTION_SCAN_CHARS = 2000;

export function applyHardExclude(
  job: { title: string; location: string | null; description_text: string | null },
  config: FilterConfig,
): FilterDecision {
  // `function` category excludes are scoped to title only — function
  // categorization is about what the role IS (in the title), and matching
  // descriptions causes false positives (e.g. a Solutions Architect role
  // mentioning "forward deployed teams" in passing).
  // Other categories (industry / location / red_flag / engagement) still scan
  // title + first 2000 chars of description, since their patterns target
  // text that typically lives in JD bodies.
  const title = job.title;
  const titlePlusDesc = `${job.title}\n${(job.description_text ?? "").slice(0, DESCRIPTION_SCAN_CHARS)}`;
  for (const e of config.excludes) {
    const haystack = e.category === "function" ? title : titlePlusDesc;
    if (e.regex.test(haystack)) {
      return { excluded: true, reason: `excludes:${e.category}` };
    }
  }

  if (job.location && config.locations.length > 0) {
    const loc = job.location.toLowerCase();
    const ok = config.locations.some((l) => loc.includes(l));
    if (!ok) {
      return { excluded: true, reason: "location:not_allowed" };
    }
  }

  return { excluded: false };
}
