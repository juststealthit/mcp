/**
 * Turns the API's rows into the compact, consistent shapes the tools return. Models read every field, so the shapes keep what helps a
 * decision and drop wire noise. Every number that may be missing is `null`, never a made-up 0.
 *
 * @module
 */
import { isOutsideToken, tokenChain, type ApiCandle, type ApiTrade, type BaseToken, type EvmApiToken, type MarketToken, type SolApiToken } from "@juststealthit/sdk/api";
import { getChain } from "@juststealthit/sdk/utils";
import { z } from "zod";

import type { Links } from "./links.js";

// ---- primitives ------------------------------------------------------------------------------------------------------------

export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
/** Unix ms → ISO 8601, or `null`. */
export const iso = (ms: unknown): string | null => (typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
/** Unix seconds → ISO 8601, or `null`. */
export const isoSec = (s: unknown): string | null => (typeof s === "number" && Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : null);
export const round = (v: number | null, digits = 4): number | null => (v === null ? null : Number(v.toFixed(digits)));

/** A decimal string cut to `digits` decimals, for sentences. The structured data keeps every digit. */
export const short = (amount: string, digits = 6) => {
  const [i, f = ""] = amount.split(".");
  const cut = f.slice(0, digits).replace(/0+$/, "");
  return cut ? `${i}.${cut}` : (i ?? amount);
};

/** Replaces bigints with decimal strings and drops `undefined`, so a value is safe as MCP structured content. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as T;
}

export const nullableNumber = z.number().nullable();
export const nullableString = z.string().nullable();

// ---- launch types ----------------------------------------------------------------------------------------------------------

/** What each launch type does with creator fees, as the docs describe it. */
export const LAUNCH_TYPES: Record<string, { label: string; summary: string }> = {
  creator: { label: "Creator", summary: "Creator fees go to the creator's wallet, in the pair token." },
  social: { label: "Social", summary: "Creator fees wait in a vault for a named social account until that person claims them. The launcher gets none." },
  wallet: { label: "Wallet", summary: "Creator fees go to an address picked at launch." },
  team: { label: "Team", summary: "Creator fees split between 2 to 10 wallets, by shares fixed at launch." },
  holders: { label: "Holders", summary: "Creator fees are paid out to holders above a minimum balance, in rounds, in the pair token." },
  diamond: { label: "Diamond Hands", summary: "Like Holders, but a wallet that sells or moves tokens out stops earning for good." },
  buyback: { label: "Buy back and burn", summary: "Creator fees buy the coin and burn what they bought, on each claim. A burn isn't a promise of any price or value." },
  feed: { label: "Feed a Coin", summary: "Creator fees buy another coin picked at launch and burn it, on each claim." },
  liquidity: { label: "Auto Liquidity", summary: "Creator fees build up in a wallet of the coin's own, then go into its pool after graduation." },
  marketing: { label: "Marketing", summary: "Creator fees fill a marketing pot that pays for an ordered ladder of promotions. The creator takes none." },
  mix: { label: "Mix", summary: "Creator fees split across 2 to 5 of the other types, in shares fixed at launch." },
  pot: { label: "Pot", summary: "The EVM contracts' general pot type: the ops bot spends it by the coin's stored fee plan." },
};

export const launchTypeLabel = (id: string | null | undefined) => (id ? (LAUNCH_TYPES[id]?.label ?? id) : null);

// ---- coins -----------------------------------------------------------------------------------------------------------------

export const STAGES = ["new", "graduating", "migrated"] as const;

export const CoinSummarySchema = z.object({
  chain: z.string(),
  address: z.string(),
  name: z.string(),
  symbol: z.string(),
  stage: z.string().describe("new, graduating or migrated (graduated); external for a token launched elsewhere"),
  priceUsd: nullableNumber,
  marketCapUsd: nullableNumber,
  liquidityUsd: nullableNumber,
  volume24hUsd: nullableNumber,
  holders: nullableNumber,
  change: z.object({ m5: nullableNumber, h1: nullableNumber, h24: nullableNumber }).describe("Percent changes"),
  graduationProgress: nullableNumber.describe("0 to 1 along the bonding curve"),
  launchType: nullableString,
  venue: nullableString,
  taxBps: nullableNumber,
  createdAt: nullableString,
  official: z.boolean(),
  onPlatform: z.boolean().describe("Launched on Just Stealth It. False for an external coin trending on its chain"),
  launchpad: nullableString.describe("For an external coin: the launchpad it came from, as the market data names it"),
  url: z.string(),
});
export type CoinSummary = z.infer<typeof CoinSummarySchema>;

/** The venue a coin trades on, in words. */
export function venueOf(t: Pick<MarketToken, "sol" | "evm">): string | null {
  if (t.sol) {
    const v = t.sol.venue ?? t.sol.kind;
    return v === "pump" ? "Pump.fun" : v === "raydium" || v === "launchlab" ? "Raydium LaunchLab" : v === "meteora" ? "Meteora" : v;
  }
  if (t.evm) return t.evm.dex === "infinity" ? "PancakeSwap Infinity" : "Uniswap v4";
  return null;
}

export const chainOf = (t: Pick<MarketToken, "sol" | "evm" | "outside">): string => tokenChain(t);

export function launchTypeOf(t: MarketToken | SolApiToken | EvmApiToken): string | null {
  const m = t as MarketToken;
  if (m.sol) return str(m.sol.feeMode);
  return str(m.feeMode) ?? str(m.evm?.launchType);
}

export function coinSummary(t: MarketToken | SolApiToken | EvmApiToken, links: Links): CoinSummary {
  const b = t as BaseToken & Pick<MarketToken, "sol" | "evm" | "outside">;
  const chain = chainOf(b);
  // an external row on the All list has no launchpad fields of its own: its zeros mean "not ours", not "zero"
  const outside = isOutsideToken(b as MarketToken);
  return {
    chain,
    address: b.address,
    name: b.name ?? "",
    symbol: b.symbol ?? "",
    stage: outside ? "external" : (str(b.status) ?? "new"),
    priceUsd: num(b.priceUsd),
    marketCapUsd: num(b.marketCapUsd),
    liquidityUsd: num(b.liquidityUsd),
    volume24hUsd: num(b.volume24hUsd),
    holders: num(b.holders),
    change: { m5: num(b.change?.m5), h1: num(b.change?.h1), h24: num(b.change?.h24) },
    graduationProgress: outside ? null : num(b.graduation?.progress),
    launchType: outside ? null : launchTypeOf(t),
    venue: outside ? null : venueOf(b),
    taxBps: outside ? null : num(b.taxBps),
    createdAt: iso(b.createdAt),
    official: b.sol?.official === true,
    onPlatform: !outside,
    launchpad: outside ? str(b.outside?.launchpad) : null,
    url: links.coin(b.address, chain, !outside),
  };
}

export const nativeSymbol = (chain: string) => getChain(chain)?.native ?? "native";

// ---- trades and candles ----------------------------------------------------------------------------------------------------

export const TradeSchema = z.object({
  time: nullableString,
  side: z.string(),
  kind: z.string(),
  trader: z.string(),
  valueUsd: nullableNumber,
  nativeAmount: nullableNumber,
  tokenAmount: nullableNumber,
  priceUsd: nullableNumber,
  sniperTaxed: z.boolean(),
  launchBuy: z.boolean(),
  tx: z.string(),
});

export function tradeRow(t: ApiTrade) {
  return {
    time: iso(t.timestamp),
    side: t.side,
    kind: t.kind,
    trader: t.trader,
    valueUsd: num(t.valueUsd),
    nativeAmount: num(t.ethAmount),
    tokenAmount: num(t.tokenAmount),
    priceUsd: num(t.priceUsd),
    sniperTaxed: t.sniperTaxed === true,
    launchBuy: t.isCreatorLaunchBuy === true,
    tx: t.txHash,
  };
}

export const CandleSchema = z.object({ time: z.number(), open: z.number(), high: z.number(), low: z.number(), close: z.number(), volume: z.number() });

export function candleRow(c: ApiCandle) {
  return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: num(c.volume) ?? 0 };
}

// ---- risk ------------------------------------------------------------------------------------------------------------------

export type RiskLevel = "green" | "amber" | "red";

/** The token page's risk card thresholds, as the docs publish them. */
export function riskFlags(r: { top10Pct?: number; devHoldingPct?: number; devSold?: boolean; devSoldPct?: number; sniperHeldPct?: number; firstBlockBuyers?: number }) {
  const band = (v: number | null, green: number, amber: number): RiskLevel | null => (v === null ? null : v <= green ? "green" : v <= amber ? "amber" : "red");
  const flags: { line: string; value: number | boolean | null; level: RiskLevel | null }[] = [
    { line: "Top 10 holders, % of supply", value: num(r.top10Pct), level: band(num(r.top10Pct), 30, 50) },
    { line: "Launcher + creator hold, % of supply", value: num(r.devHoldingPct), level: band(num(r.devHoldingPct), 5, 10) },
    { line: "Launcher or creator sold", value: r.devSold ?? null, level: r.devSold === undefined ? null : r.devSold ? "amber" : "green" },
    { line: "Snipers still hold, % of supply", value: num(r.sniperHeldPct), level: band(num(r.sniperHeldPct), 5, 15) },
    { line: "First-block buyers besides the launcher", value: num(r.firstBlockBuyers), level: null },
  ];
  return flags;
}

export const RiskFlagSchema = z.object({ line: z.string(), value: z.union([z.number(), z.boolean()]).nullable(), level: z.enum(["green", "amber", "red"]).nullable() });

// ---- paging ----------------------------------------------------------------------------------------------------------------

const CURSOR_PREFIX = "p1.";

/**
 * A page cursor for a tool that shows fewer rows than the API's page holds. It remembers the API's cursor and how many of that page's
 * rows were already shown, so the next call starts at the first row not shown instead of skipping the rest of the page.
 */
export function pageCursor(apiCursor: string | null | undefined, skip: number): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify({ c: apiCursor ?? null, s: skip })).toString("base64url");
}

/** Reads a cursor from {@link pageCursor}. Anything else is taken as the API's own cursor, so older cursors keep working. */
export function readPageCursor(cursor: string | undefined): { api: string | undefined; skip: number } {
  if (!cursor?.startsWith(CURSOR_PREFIX)) return { api: cursor, skip: 0 };
  try {
    const v = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8")) as { c?: unknown; s?: unknown };
    const skip = typeof v.s === "number" && Number.isInteger(v.s) && v.s >= 0 && v.s <= 10_000 ? v.s : 0;
    return { api: typeof v.c === "string" ? v.c : undefined, skip };
  } catch {
    return { api: undefined, skip: 0 };
  }
}

/**
 * Shows up to `limit` rows of an API page, from where the cursor left off. `nextCursor` continues inside this page while rows are
 * left, then moves to the API's next page. `left` counts this page's rows not shown yet.
 */
export function pageSlice<T>(items: T[], skip: number, limit: number, apiCursor: string | undefined, apiNext: string | null | undefined) {
  const rest = items.slice(skip);
  const shown = rest.slice(0, limit);
  const left = rest.length - shown.length;
  const nextCursor = left > 0 ? pageCursor(apiCursor, skip + shown.length) : (apiNext ?? null);
  return { shown, left, nextCursor };
}

/** Trims an array for output, saying how much was left out. */
export function take<T>(items: T[], limit: number): { items: T[]; truncated: number } {
  return { items: items.slice(0, limit), truncated: Math.max(0, items.length - limit) };
}
