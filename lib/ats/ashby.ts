import type { NormalizedJob } from "./types";
import { stripHtml } from "./html";

type AshbyJob = {
  id: string;
  title: string;
  location?: string;
  jobUrl: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  publishedDate?: string;
  publishedAt?: string;
};

export async function fetchJobs(slug: string): Promise<NormalizedJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`ashby ${slug}: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { jobs?: AshbyJob[] };
  return (data.jobs ?? []).map((j) => {
    const description = j.descriptionPlain ?? (j.descriptionHtml ? stripHtml(j.descriptionHtml) : "");
    const posted = j.publishedDate ?? j.publishedAt;
    return {
      external_id: j.id,
      title: j.title,
      location: j.location ?? null,
      url: j.jobUrl,
      description_text: description,
      posted_at: posted ? new Date(posted) : null,
    };
  });
}
