import { NextResponse } from "next/server";
import { runSync } from "@/lib/sync";
import { runEvaluate } from "@/lib/evaluate-runner";
import { runDiscover } from "@/lib/discover";
import { runClassify } from "@/lib/classify-runner";
import { runDigest } from "@/lib/digest";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${expected}`) return true;
  const url = new URL(req.url);
  if (url.searchParams.get("secret") === expected) return true;
  return false;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sync = await runSync();
  const evaluate = await runEvaluate();
  const discover = await runDiscover();
  const classify = await runClassify();
  const digest = await runDigest();

  const overall =
    sync.status === "error" ||
    evaluate.status === "error" ||
    discover.status === "error" ||
    classify.status === "error" ||
    digest.status === "error"
      ? "partial"
      : "ok";

  return NextResponse.json({
    overall,
    sync,
    evaluate,
    discover,
    classify,
    digest,
  });
}
