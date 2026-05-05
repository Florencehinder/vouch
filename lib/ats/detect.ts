import type { AtsDetection } from "./types";

const HOST_RULES: Array<{
  match: RegExp;
  provider: Exclude<AtsDetection["provider"], "scrape">;
  slugFromPath?: boolean;
}> = [
  { match: /(^|\.)greenhouse\.io$/i, provider: "greenhouse", slugFromPath: true },
  { match: /(^|\.)lever\.co$/i, provider: "lever", slugFromPath: true },
  { match: /(^|\.)ashbyhq\.com$/i, provider: "ashby", slugFromPath: true },
  { match: /(^|\.)smartrecruiters\.com$/i, provider: "smartrecruiters", slugFromPath: true },
  { match: /myworkdayjobs\.com$/i, provider: "workday", slugFromPath: false },
];

const HTML_RULES: Array<{
  pattern: RegExp;
  provider: Exclude<AtsDetection["provider"], "scrape" | "workday">;
  slugGroup: number;
}> = [
  // Greenhouse JS embed: <script src="https://boards.greenhouse.io/embed/job_board/js?for=anthropic">
  // Or: boards.greenhouse.io/<slug>
  { pattern: /boards\.greenhouse\.io\/embed\/job_board\/js\?for=([a-z0-9-_]+)/i, provider: "greenhouse", slugGroup: 1 },
  { pattern: /boards\.greenhouse\.io\/([a-z0-9-_]+)/i, provider: "greenhouse", slugGroup: 1 },
  // Lever JS embed: jobs.lever.co/<slug>
  { pattern: /jobs\.lever\.co\/([a-z0-9-_]+)/i, provider: "lever", slugGroup: 1 },
  // Ashby embed: jobs.ashbyhq.com/<org>
  { pattern: /jobs\.ashbyhq\.com\/([a-z0-9-_]+)/i, provider: "ashby", slugGroup: 1 },
  // SmartRecruiters: careers.smartrecruiters.com/<slug>  or  jobs.smartrecruiters.com/<slug>
  { pattern: /(?:careers|jobs)\.smartrecruiters\.com\/([a-z0-9-_]+)/i, provider: "smartrecruiters", slugGroup: 1 },
];

function detectFromUrl(careersUrl: string): AtsDetection | null {
  let u: URL;
  try {
    u = new URL(careersUrl);
  } catch {
    return null;
  }
  for (const rule of HOST_RULES) {
    if (rule.match.test(u.hostname)) {
      if (rule.provider === "workday") {
        return { provider: "workday", slug: u.hostname };
      }
      const slug = u.pathname.split("/").filter(Boolean)[0];
      if (rule.slugFromPath && slug) return { provider: rule.provider, slug };
    }
  }
  return null;
}

async function detectFromHtml(careersUrl: string): Promise<AtsDetection | null> {
  const res = await fetch(careersUrl, {
    redirect: "follow",
    headers: { "user-agent": "Vouch/0.1 (+personal job tracker)" },
  });
  if (!res.ok) return null;
  const html = await res.text();
  for (const rule of HTML_RULES) {
    const m = html.match(rule.pattern);
    if (m) return { provider: rule.provider, slug: m[rule.slugGroup] };
  }
  return null;
}

export async function detect(careersUrl: string): Promise<AtsDetection> {
  const fromUrl = detectFromUrl(careersUrl);
  if (fromUrl) return fromUrl;

  try {
    const fromHtml = await detectFromHtml(careersUrl);
    if (fromHtml) return fromHtml;
  } catch {
    // network failure on careers page — treat as scrape
  }

  return { provider: "scrape", slug: null };
}
