import type { NormalizedJob } from "./types";
import { stripHtml } from "./html";

type GhJob = {
  id: number;
  title: string;
  location?: { name?: string };
  absolute_url: string;
  content?: string;
  updated_at?: string;
  first_published?: string;
};

export async function fetchJobs(slug: string): Promise<NormalizedJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`greenhouse ${slug}: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { jobs?: GhJob[] };
  return (data.jobs ?? []).map((j) => ({
    external_id: String(j.id),
    title: j.title,
    location: j.location?.name ?? null,
    url: j.absolute_url,
    description_text: j.content ? stripHtml(j.content) : "",
    posted_at: j.first_published ? new Date(j.first_published) : j.updated_at ? new Date(j.updated_at) : null,
  }));
}
