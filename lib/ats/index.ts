import type { AtsProvider, NormalizedJob } from "./types";
import * as greenhouse from "./greenhouse";
import * as lever from "./lever";
import * as ashby from "./ashby";
import * as smartrecruiters from "./smartrecruiters";

export { detect } from "./detect";
export type { AtsDetection, AtsProvider, NormalizedJob } from "./types";

export async function fetchJobs(provider: AtsProvider, slug: string): Promise<NormalizedJob[]> {
  switch (provider) {
    case "greenhouse":
      return greenhouse.fetchJobs(slug);
    case "lever":
      return lever.fetchJobs(slug);
    case "ashby":
      return ashby.fetchJobs(slug);
    case "smartrecruiters":
      return smartrecruiters.fetchJobs(slug);
    case "workday":
      throw new Error("workday adapter not implemented (deferred per PLAN.md)");
    case "scrape":
      throw new Error("scrape adapter not implemented (Phase 3+)");
  }
}
