import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
import { readJobsFeedback, ensureFeedbackHeaders, type JobsFeedbackRow } from "./sheets";

// Bumped from v2 → v3: now injects user feedback as few-shot examples.
// Bumping invalidates v2 classifications so everything gets re-scored with the
// new prompt (one-time ~$3 cost; steady-state daily runs are still cents).
export const CLASSIFICATION_VERSION = "v3";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// How many recent feedback examples to inject into the prompt. Cap to keep
// the system prompt size predictable. Examples beyond this are silently dropped
// (most-recent-first ordering is enforced by sheet row order).
const MAX_FEEDBACK_EXAMPLES = 12;

// Load CV at module init. cv.md is gitignored; for production deploys, set
// env var CV_TEXT (base64-encoded) as an alternative.
const CV_PATH = "./cv.md";
const CV_TEXT = process.env.CV_TEXT
  ? Buffer.from(process.env.CV_TEXT, "base64").toString("utf8")
  : existsSync(CV_PATH)
    ? readFileSync(CV_PATH, "utf8")
    : "(no CV provided — running without candidate-specific scoring)";

// Cached prompt built lazily from current feedback. Re-built each runClassify run
// (the runner calls reloadSystemPrompt() before classifying).
let SYSTEM = buildSystem("");

export async function reloadSystemPrompt(): Promise<{ examples_used: number }> {
  // Ensure K/L headers exist so user can add feedback inline; idempotent.
  try {
    await ensureFeedbackHeaders();
  } catch (e) {
    console.warn(`[classify] ensureFeedbackHeaders failed: ${e instanceof Error ? e.message : e}`);
  }
  const all = await readJobsFeedback().catch((e) => {
    console.warn(`[classify] readJobsFeedback failed: ${e instanceof Error ? e.message : e}`);
    return [] as JobsFeedbackRow[];
  });
  // Most-recent-first heuristic: digest appends new rows at the bottom, so
  // reverse the sheet order to surface latest feedback first.
  const examples = all.slice().reverse().slice(0, MAX_FEEDBACK_EXAMPLES);
  SYSTEM = buildSystem(formatExamples(examples));
  return { examples_used: examples.length };
}

const FEEDBACK_LABEL: Record<string, string> = {
  "++": "LOVED — calibrate UP for this shape",
  "+": "BETTER than rated — calibrate UP",
  "-": "LESS RELEVANT than rated — calibrate DOWN",
  "--": "NEVER AGAIN — strong DOWN signal",
};

function formatExamples(examples: JobsFeedbackRow[]): string {
  if (!examples.length) return "";
  const lines = examples.map((e) => {
    const label = FEEDBACK_LABEL[e.feedback] ?? e.feedback;
    const cat = e.category ?? "?";
    const score = e.score?.toFixed(2) ?? "?";
    const reason = e.feedback_reason ? ` (user: "${e.feedback_reason}")` : "";
    return `- "${e.title}" @ ${e.company} — current classification ${cat}@${score}. User feedback: ${label}${reason}.`;
  });
  return `

USER FEEDBACK FROM PAST CLASSIFICATIONS (use these to calibrate this run — match the patterns the user wants more of, downweight the ones they reject):
${lines.join("\n")}

When scoring a new role, ask: does it look more like the user's ++/+ examples (score up), or their -/-- examples (score down)? Carry this into your reasoning explicitly when relevant.`;
}

function buildSystem(feedbackBlock: string): string {
  return `You are screening job postings for a specific candidate. For each posting, decide:

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

REASONING (one sentence): MUST mention specific overlap (or specific mismatch) with the candidate's CV. Reference past employers/projects/skills by name.
  good: "Senior PM for Claude API growth at Anthropic — leverages your RAG deployment work at 8ai.co.nz, the commercial+product role at Spark Wave, and the AI cohort facilitation at EF; right stage and London-friendly."
  good: "International Readiness Lead is mostly compliance/policy/sovereign-deployment strategy, not hands-on technical AI work — mismatches your Solutions Engineer / RAG-deployment trajectory."
  bad: "This is a PM role and you'd be a good fit." (no CV reference)
${feedbackBlock}
Reply with ONLY valid JSON, no preamble or backticks:
{"category": "pm" | "ds_fde" | "tpm" | "program_mgr" | "none", "confidence": 0.0-1.0, "reasoning": "one sentence with specific CV reference"}`;
}

export type Classification = {
  category: "pm" | "ds_fde" | "tpm" | "program_mgr" | "none";
  confidence: number;
  reasoning: string;
};

export type ClassifyInput = {
  title: string;
  company_name: string;
  location: string | null;
  description_text: string;
};

const VALID_CATEGORIES = new Set(["pm", "ds_fde", "tpm", "program_mgr", "none"]);

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function tryParse(raw: string): Classification | null {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Tolerate prose-before-JSON by extracting the last balanced {...} block
  if (!cleaned.startsWith("{")) {
    const start = cleaned.lastIndexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const category = String(p.category ?? "");
  const confidence = Number(p.confidence ?? NaN);
  const reasoning = String(p.reasoning ?? "");
  if (!VALID_CATEGORIES.has(category)) return null;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { category: category as Classification["category"], confidence, reasoning };
}

export async function classifyJob(input: ClassifyInput): Promise<Classification> {
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
      system: SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    });
    const raw = res.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = tryParse(raw);
    if (parsed) return parsed;
    if (attempt === 2) {
      throw new Error(`haiku returned unparseable JSON twice: ${raw.slice(0, 200)}`);
    }
  }
  throw new Error("classifyJob: unreachable");
}
