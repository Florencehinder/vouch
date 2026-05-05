import type { NormalizedJob } from "./types";
import { stripHtml } from "./html";

type LeverPosting = {
  id: string;
  text: string;
  categories?: { location?: string; team?: string; commitment?: string };
  hostedUrl: string;
  description?: string;
  descriptionPlain?: string;
  lists?: Array<{ text: string; content: string }>;
  additional?: string;
  additionalPlain?: string;
  createdAt?: number;
};

export async function fetchJobs(slug: string): Promise<NormalizedJob[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`lever ${slug}: HTTP ${res.status}`);
  }
  const postings = (await res.json()) as LeverPosting[];
  return postings.map((p) => {
    const sections: string[] = [];
    if (p.descriptionPlain) sections.push(p.descriptionPlain);
    else if (p.description) sections.push(stripHtml(p.description));
    for (const l of p.lists ?? []) {
      sections.push(`${l.text}:\n${stripHtml(l.content)}`);
    }
    if (p.additionalPlain) sections.push(p.additionalPlain);
    else if (p.additional) sections.push(stripHtml(p.additional));
    return {
      external_id: p.id,
      title: p.text,
      location: p.categories?.location ?? null,
      url: p.hostedUrl,
      description_text: sections.join("\n\n").trim(),
      posted_at: p.createdAt ? new Date(p.createdAt) : null,
    };
  });
}
