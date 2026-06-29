import type { ApiCycle } from "../../types.ts";

/** Format a USD amount with precision scaled to the magnitude. */
export function formatUsd(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(5)}`;
}

/** Format an AI-credit amount compactly. */
export function formatCredits(credits: number): string {
  if (credits <= 0) return "0";
  return credits >= 10 ? credits.toFixed(0) : credits.toFixed(2);
}

export interface CostTotals {
  priced: boolean;
  usd: number;
  aiCredits: number;
  premiumRequests: number;
  input: number;
  output: number;
}

/** Aggregate cost across a task's cycles, or null when no cycle carries cost. */
export function sumCycleCosts(cycles: ApiCycle[]): CostTotals | null {
  let any = false;
  // `priced` for the total means *every* contributing cycle is authoritatively
  // priced; a single estimated cycle makes the whole total an estimate (shown
  // with a `~` prefix). Starts true and is cleared by the first unpriced cycle.
  const totals: CostTotals = { priced: true, usd: 0, aiCredits: 0, premiumRequests: 0, input: 0, output: 0 };
  for (const c of cycles) {
    if (!c.cost) continue;
    any = true;
    if (!c.cost.priced) totals.priced = false;
    totals.usd += c.cost.usd;
    totals.aiCredits += c.cost.aiCredits;
    totals.premiumRequests += c.cost.premiumRequests;
    totals.input += c.cost.tokens.input;
    totals.output += c.cost.tokens.output;
  }
  return any ? totals : null;
}
