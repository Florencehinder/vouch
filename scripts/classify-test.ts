import "../lib/env";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
import { supabaseService } from "../lib/supabase";

const CV_TEXT = existsSync("./cv.md")
  ? readFileSync("./cv.md", "utf8")
  : (() => { throw new Error("./cv.md not found — please create it first"); })();

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// New v2 prompt: CV-aware. Confidence reflects fit for THIS candidate, not just
// generic role-shape. Reasoning must reference specific CV overlap or mismatch.
const SYSTEM_V2 = `You are screening job postings for a specific candidate. For each posting, decide:

1. Does this role match one of the candidate's target categories?
2. How well does it match THIS candidate's specific background?

CANDIDATE PROFILE (FROM CV):
${CV_TEXT}

TARGET CATEGORIES (or "none"):
- "pm": Product Manager (Senior+, Group, Principal, Head of Product, CPO)
- "ds_fde": Deployment Strategist / Forward Deployed Engineer / Solutions Engineer or Architect / Customer Engineer / GTM Engineer / Applied AI Engineer
- "tpm": Technical Program Manager
- "program_mgr": Program Manager / Programme Manager
- "none": Doesn't fit any of the above

REJECT (category="none") IF:
- Pure backend/infra software engineering with no customer-facing or embedded element
- Sales-only (BDR/SDR/AE), pure marketing, customer-success without technical depth, recruiting/HR/finance/legal
- Engineering Manager (managing engineers, not products)
- Product Marketing / Product Ops / Product Design

CRITICAL — what counts as TARGET "deployment" work for THIS candidate (most-fit to least-fit):
1. HANDS-ON TECHNICAL AI DEPLOYMENT — building/integrating production AI systems with customers, RAG architecture, evals, model implementation, customer onboarding (e.g. Forward Deployed Engineer at Anthropic, Solutions Engineer at Cohere/Mistral, Applied/Customer AI Engineer).
2. TECHNICAL DEPLOYMENT STRATEGY with hands-on flavor — defining how AI gets deployed for customers, owning the technical-commercial boundary, customer architecture work (e.g. Deployment Strategist at Anthropic, technical Sales/Solutions Architect with deep customer engineering work).
3. PRODUCT MANAGEMENT for AI products with real customer access (e.g. Senior PM at Anthropic for an externally-facing product like Claude API or Claude Code).
4. TECHNICAL PROGRAM MANAGEMENT for AI infrastructure / shipping deployment-shaped programs.
5. PROGRAM MANAGEMENT in operational programs adjacent to AI delivery.

WHAT DOES NOT COUNT as target deployment work — DOWNGRADE THESE EVEN IF "DEPLOYMENT" OR "GTM" APPEARS IN TITLE:
- International compliance / data residency / sovereign AI policy / regulatory frameworks
- Pure regulatory affairs, public policy, government affairs, trust & safety policy
- Pure business development, partnerships, licensing without technical depth
- Operational program management without hands-on AI/technical work
- "Deployment" that's actually international commercial expansion or compliance navigation rather than customer-facing AI deployment

A role with "deployment", "international", "GTM" or "strategy" in the title does NOT automatically score highly. Read the actual responsibilities. If the bulk of the job is compliance, policy, business strategy, or operational coordination without hands-on technical AI work, the score must reflect that — typically 0.65 or lower, even if the surface keywords sound aligned.

CONFIDENCE = match for THIS candidate (not generic role-shape):
- 0.95: Ideal match. Target category in tier 1–2 above + specific CV overlap (refer to a named past role) + right geography/stage. e.g. a London-based "AI Solutions Engineer, RAG deployment" role for someone whose CV shows RAG architecture work at 8ai.co.nz AND Solutions Engineering at Optibus.
- 0.85: Strong fit, one real gap. Role is in tier 1–3 above with strong CV overlap, but is missing one important element (e.g. wants 8+ years deep ML eng, candidate has 2 years AI deployment + 5 years adjacent; or right role but US-only on-site).
- 0.75: Decent fit. Tier 3–4 role, OR a tier 1–2 role with a meaningful skill/domain gap.
- 0.65: Stretch / edge case. Role pivots away from technical AI deployment toward strategy/policy/operations, even if some surface alignment exists. Surface so candidate can decide; do not over-promote.
- below 0.60: classify as "none".

CV-SPECIFIC ANCHORS (use these to score overlap):
- RAG / LLM deployment → 8ai.co.nz, EF AI cohorts, Future Journeys AI-TTS
- Solutions Engineering / customer onboarding / debugging integrations → Optibus (post-sales, Firstbus implementation)
- Forward-deployed-style implementation in regulated industries → HAL/Thames Water hydraulic transient system, Auckland Transport bilingual audio rollout
- Product Management / 0-to-1 product / roadmap → Spark Wave (Thoughtsaver), Flexsta, EF Insurance for AI
- Government / large enterprise stakeholder management → £9M Manchester tender, Auckland Transport ($150M), Thames Water
- Founder / commercial-product blend → Flexsta, Future Journeys, EF cofounder
- Geography → London-based; UK + NZ citizen; Auckland-friendly

REASONING (one sentence): MUST mention specific overlap (or specific mismatch) with the candidate's CV. Reference past employers/projects/skills by name. Examples:
  good: "Senior Product Manager for Claude API growth at Anthropic — leverages your RAG deployment work at 8ai.co.nz, the commercial+product role at Spark Wave, and the AI cohort facilitation at EF; right stage and London-friendly."
  good: "Backend infra engineer with no customer-facing element — mismatches your deployment-strategist trajectory; you'd be regressing from the Solutions Engineering work at Optibus and HAL/Thames Water."
  bad: "This is a PM role and you'd be a good fit." (no CV reference)

Reply with ONLY valid JSON, no preamble or backticks:
{"category": "pm" | "ds_fde" | "tpm" | "program_mgr" | "none", "confidence": 0.0-1.0, "reasoning": "one sentence with specific CV reference"}`;

type Classification = {
  category: "pm" | "ds_fde" | "tpm" | "program_mgr" | "none";
  confidence: number;
  reasoning: string;
};

const VALID = new Set(["pm", "ds_fde", "tpm", "program_mgr", "none"]);

let client: Anthropic | null = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function tryParse(raw: string): Classification | null {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!cleaned.startsWith("{")) {
    const s = cleaned.lastIndexOf("{");
    const e = cleaned.lastIndexOf("}");
    if (s >= 0 && e > s) cleaned = cleaned.slice(s, e + 1);
  }
  try {
    const p = JSON.parse(cleaned) as Record<string, unknown>;
    const cat = String(p.category ?? "");
    const conf = Number(p.confidence ?? NaN);
    const reason = String(p.reasoning ?? "");
    if (!VALID.has(cat) || !Number.isFinite(conf) || conf < 0 || conf > 1) return null;
    return { category: cat as Classification["category"], confidence: conf, reasoning: reason };
  } catch {
    return null;
  }
}

async function classifyV2(input: { title: string; company_name: string; location: string | null; description_text: string }): Promise<Classification> {
  const userMsg = `Title: ${input.title}
Company: ${input.company_name}
Location: ${input.location ?? "n/a"}

Description:
${input.description_text.slice(0, 8000)}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await getClient().messages.create({
      model: HAIKU_MODEL,
      max_tokens: 300,
      temperature: 0,
      system: SYSTEM_V2,
      messages: [{ role: "user", content: userMsg }],
    });
    const raw = res.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = tryParse(raw);
    if (parsed) return parsed;
    if (attempt === 2) throw new Error(`unparseable: ${raw.slice(0, 200)}`);
  }
  throw new Error("unreachable");
}

type SampleJob = {
  job_id: string;
  title: string;
  location: string | null;
  description_text: string;
  company_name: string;
  v1_category: string;
  v1_confidence: number;
  v1_reasoning: string;
};

async function fetchSamples(): Promise<SampleJob[]> {
  // Pick 8 representative jobs:
  //  - 2 top PM matches (score >= 0.85)
  //  - 2 top DS/FDE matches (score >= 0.85)
  //  - 1 borderline PM (0.60-0.79)
  //  - 1 borderline DS/FDE (0.60-0.79)
  //  - 1 strong "none" rejection (score >= 0.85, category=none)
  //  - 1 borderline "none" (0.60-0.79, category=none)
  const buckets: Array<{ label: string; cat: string; min: number; max: number; n: number }> = [
    { label: "top-pm",        cat: "pm",     min: 0.85, max: 1.01, n: 2 },
    { label: "top-dsfde",     cat: "ds_fde", min: 0.85, max: 1.01, n: 2 },
    { label: "borderline-pm", cat: "pm",     min: 0.60, max: 0.79, n: 1 },
    { label: "borderline-ds", cat: "ds_fde", min: 0.60, max: 0.79, n: 1 },
    { label: "strong-none",   cat: "none",   min: 0.85, max: 1.01, n: 1 },
    { label: "weak-none",     cat: "none",   min: 0.60, max: 0.79, n: 1 },
  ];
  const out: SampleJob[] = [];
  for (const b of buckets) {
    const { data, error } = await supabaseService
      .from("job_matches")
      .select("match_score, matched_role_category, classification_reasoning, jobs!inner(id, title, location, description_text, companies(name))")
      .eq("matched_role_category", b.cat)
      .gte("match_score", b.min)
      .lt("match_score", b.max)
      .order("match_score", { ascending: false })
      .limit(b.n);
    if (error) throw error;
    for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
      const job = row.jobs as Record<string, unknown>;
      const co = Array.isArray(job.companies) ? (job.companies as Array<{ name: string }>)[0] : (job.companies as { name: string });
      out.push({
        job_id: job.id as string,
        title: job.title as string,
        location: (job.location as string | null) ?? null,
        description_text: (job.description_text as string | null) ?? "",
        company_name: co?.name ?? "(unknown)",
        v1_category: row.matched_role_category as string,
        v1_confidence: Number(row.match_score),
        v1_reasoning: (row.classification_reasoning as string | null) ?? "",
      });
    }
  }
  return out;
}

function colorize(label: string, color: "green" | "yellow" | "red" | "dim" = "green"): string {
  const codes: Record<string, string> = { green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", dim: "\x1b[2m" };
  return `${codes[color]}${label}\x1b[0m`;
}

async function main() {
  console.log("loading samples from DB...");
  const samples = await fetchSamples();
  console.log(`got ${samples.length} samples\n`);
  console.log(`Running v2 classification (CV-aware) on each...\n`);

  for (const s of samples) {
    process.stdout.write(`${colorize("→", "dim")} ${s.company_name} | ${s.title.slice(0, 70)}\n`);
    let v2;
    try {
      v2 = await classifyV2(s);
    } catch (e) {
      console.log(`   ${colorize("ERROR", "red")}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const v1Bar = `${s.v1_category.padEnd(10)} @ ${s.v1_confidence.toFixed(2)}`;
    const v2Bar = `${v2.category.padEnd(10)} @ ${v2.confidence.toFixed(2)}`;
    const delta = v2.confidence - s.v1_confidence;
    const deltaStr = delta > 0 ? colorize(`+${delta.toFixed(2)}`, "green") : delta < 0 ? colorize(delta.toFixed(2), "yellow") : "  =  ";
    const catChange = v2.category !== s.v1_category ? colorize(` [${s.v1_category} → ${v2.category}]`, "yellow") : "";
    console.log(`   v1: ${v1Bar}${catChange}`);
    console.log(`       ${colorize(s.v1_reasoning.slice(0, 200), "dim")}`);
    console.log(`   v2: ${v2Bar}  Δ ${deltaStr}`);
    console.log(`       ${v2.reasoning.slice(0, 240)}`);
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
