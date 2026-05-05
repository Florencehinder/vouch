import Anthropic from "@anthropic-ai/sdk";

export const EVALUATION_VERSION = "v1";

const SONNET_MODEL = "claude-sonnet-4-6";

const SYSTEM = `You are evaluating companies as job-search targets for a candidate with this profile:

CANDIDATE PROFILE:
- Based in London / UK; targeting senior PM, Deployment Strategist / Forward Deployed Engineer / Solutions Engineer / Architect, Technical Program Manager, or Program Manager roles.
- Long-term target: Anthropic TDL (Technical Deployment Lead) or founder path.
- Optimizing for AI deployment career capital — production AI systems exposure, RAG / evals work, customer deployment cycles, technical depth alongside commercial work.
- Parenthood timing matters: prefers Series B–D with strong commercial traction (decent benefits, real ownership). Pre-PMF startups score lower; mega-corps score lower on growth velocity.
- May relocate to Auckland NZ in 3–5 years (geographic optionality is a small bonus).
- Mission preference: Anthropic > Palantir on safety / responsible-AI alignment.

EVALUATE THE COMPANY ON 6 DIMENSIONS (integer 1–5; 5 = strongest fit):

1. ai_deployment_score (HIGH WEIGHT) — Does working here build the specific muscles for Anthropic TDL or founder path? Production AI systems exposure, RAG/evals, customer deployment cycles, technical+commercial blend. Anthropic = 5, Mistral Deployment Strategist = 5, generic non-AI SaaS PM = 2.
2. team_caliber_score (HIGH WEIGHT) — Not famous researchers but the daily team. Would the candidate learn from coworkers? Verifiable via LinkedIn / recent hires.
3. customer_access_score (HIGH WEIGHT) — Will the candidate be in the room with customers, or behind a wall? FDE / Deployment usually high. Product roles at large orgs often low. The single biggest lever for PM growth and founder prep.
4. network_alumni_score (MEDIUM WEIGHT) — Where do alumni go after? Strong founder / VC / strong-second-acts = high. Obscurity = low even if work was interesting.
5. stage_score (MEDIUM WEIGHT) — Series B–D with strong commercial traction = sweet spot (5). Pre-PMF = 1–2. Mega-corps with slow growth = 2–3. Public companies still expanding = 3–4.
6. mission_score (LOW WEIGHT) — Frontier AI safety / capability / responsible deployment = 5. Defence-only = 3. Pure commercial without alignment angle = 2. Crypto / gambling / surveillance / tobacco = 1.

ASSIGN A TIER:
- "A" — apply on sight. Strong on the high-weight dimensions (AI deployment + team + customer access). Top targets.
- "B" — apply if the role itself is strong. Need both company fit and role fit.
- "C" — monitor, don't pursue. Passes filters but doesn't excite.
- "Failed" — hard fail. Crypto / gambling / tobacco; ethical mismatches; clearly wrong stage (e.g., zombie companies); pure mega-corp with zero AI deployment angle.

Reply with ONLY valid JSON, no preamble or backticks:
{"ai_deployment_score": 1-5, "team_caliber_score": 1-5, "customer_access_score": 1-5, "network_alumni_score": 1-5, "stage_score": 1-5, "mission_score": 1-5, "tier": "A" | "B" | "C" | "Failed", "reasoning": "one sentence summarizing why this tier"}`;

export type CompanyEvaluation = {
  ai_deployment_score: number;
  team_caliber_score: number;
  customer_access_score: number;
  network_alumni_score: number;
  stage_score: number;
  mission_score: number;
  tier: "A" | "B" | "C" | "Failed";
  reasoning: string;
};

export type EvaluateInput = {
  name: string;
  careers_url: string | null;
  notes: string | null;
};

const VALID_TIERS = new Set(["A", "B", "C", "Failed"]);
const SCORE_KEYS = [
  "ai_deployment_score",
  "team_caliber_score",
  "customer_access_score",
  "network_alumni_score",
  "stage_score",
  "mission_score",
] as const;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function tryParse(raw: string): CompanyEvaluation | null {
  // Strip backtick fences first
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // If the model prefixed prose before the JSON, extract the last balanced {...} block
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
  const tier = String(p.tier ?? "");
  if (!VALID_TIERS.has(tier)) return null;
  const reasoning = String(p.reasoning ?? "");
  const result: Record<string, unknown> = { tier, reasoning };
  for (const k of SCORE_KEYS) {
    const n = Number(p[k]);
    if (!Number.isInteger(n) || n < 1 || n > 5) return null;
    result[k] = n;
  }
  return result as unknown as CompanyEvaluation;
}

export async function evaluateCompany(input: EvaluateInput): Promise<CompanyEvaluation> {
  const userMsg = `Company: ${input.name}
Careers URL: ${input.careers_url ?? "(none)"}
Notes (from sheet): ${input.notes ?? "(none)"}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await getClient().messages.create({
      model: SONNET_MODEL,
      max_tokens: 500,
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
      throw new Error(`evaluator returned unparseable JSON twice: ${raw.slice(0, 200)}`);
    }
  }
  throw new Error("evaluateCompany: unreachable");
}
