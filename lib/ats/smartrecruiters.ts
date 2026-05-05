import type { NormalizedJob } from "./types";
import { stripHtml } from "./html";

type SrPostingSummary = {
  id: string;
  name: string;
  ref: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean };
};

type SrPostingDetail = {
  id: string;
  name: string;
  ref: string;
  postingUrl?: string;
  applyUrl?: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean };
  jobAd?: {
    sections?: Record<string, { title?: string; text?: string }>;
  };
};

function locationString(loc?: SrPostingSummary["location"]): string | null {
  if (!loc) return null;
  const parts = [loc.city, loc.region, loc.country].filter(Boolean);
  const base = parts.join(", ");
  if (loc.remote) return base ? `${base} (remote)` : "Remote";
  return base || null;
}

async function fetchAllPostings(slug: string): Promise<SrPostingSummary[]> {
  const out: SrPostingSummary[] = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`smartrecruiters ${slug} list: HTTP ${res.status}`);
    const data = (await res.json()) as { content?: SrPostingSummary[]; totalFound?: number };
    const batch = data.content ?? [];
    out.push(...batch);
    if (batch.length < limit) return out;
    offset += limit;
  }
}

async function fetchOnePosting(slug: string, id: string): Promise<SrPostingDetail | null> {
  const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  return (await res.json()) as SrPostingDetail;
}

export async function fetchJobs(slug: string): Promise<NormalizedJob[]> {
  const summaries = await fetchAllPostings(slug);

  const concurrency = 8;
  const details: Array<SrPostingDetail | null> = new Array(summaries.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, summaries.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= summaries.length) return;
        details[idx] = await fetchOnePosting(slug, summaries[idx].id);
      }
    }),
  );

  return summaries.map((s, i) => {
    const d = details[i];
    const sections = Object.values(d?.jobAd?.sections ?? {})
      .map((sec) => {
        const text = sec.text ? stripHtml(sec.text) : "";
        return sec.title ? `${sec.title}\n${text}` : text;
      })
      .filter(Boolean)
      .join("\n\n");
    return {
      external_id: s.id,
      title: s.name,
      location: locationString(s.location),
      url: d?.postingUrl ?? d?.applyUrl ?? s.ref,
      description_text: sections,
      posted_at: s.releasedDate ? new Date(s.releasedDate) : null,
    };
  });
}
