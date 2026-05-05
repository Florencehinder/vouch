export type AtsProvider =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "workday"
  | "scrape";

export type AtsDetection =
  | { provider: Exclude<AtsProvider, "scrape">; slug: string }
  | { provider: "scrape"; slug: null };

export type NormalizedJob = {
  external_id: string;
  title: string;
  location: string | null;
  url: string;
  description_text: string;
  posted_at: Date | null;
};
