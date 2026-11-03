/**
 * Finding a coin by address on whichever chain it lives, and the full coin report: market, graduation, launch, launch type, fee routing
 * and risk in one answer.
 *
 * @module
 */
import { isEvmTokenAddress, type EvmTokenDetail, type MarketCoinDetail, type SolTokenDetail } from "@juststealthit/sdk/api";
import { sniperFeeBps, PLATFORM_SHARE_BPS, COIN_SHARE_BPS } from "@juststealthit/sdk/math";
import { METEORA_TIERS, PUMP_SHARES, RAYDIUM_TIERS } from "@juststealthit/sdk/solana";
import { isSolanaAddress } from "@juststealthit/sdk/utils";
import { z } from "zod";

import { CHAIN_KEYS, EVM_CHAIN_KEYS, isEvmChain, type ChainKey, type EvmChain } from "../config.js";
import type { StealthContext } from "../context.js";
import { NotFoundError, RefusedError } from "../errors.js";
import {
  LAUNCH_TYPES,
  RiskFlagSchema,
  iso,
  launchTypeOf,
  nativeSymbol,
  nullableNumber,
  nullableString,
  num,
  riskFlags,
  round,
  str,
  venueOf,
} from "../format.js";

export const ChainSchema = z.enum(CHAIN_KEYS).describe("solana, robinhood, bnb, hyperevm, base or arc");
export const AddressSchema = z
  .string()
  .trim()
  .min(32)
  .max(44)
  .refine((a) => isSolanaAddress(a) || isEvmTokenAddress(a), "a Solana address (base58) or an EVM address (0x + 40 hex)")
  .describe("The coin's address: a Solana mint or an EVM token address");

export type ResolvedCoin =
  | { kind: "sol"; chain: "solana"; address: string; token: SolTokenDetail }
  | { kind: "evm"; chain: EvmChain; address: string; token: EvmTokenDetail; alsoOn?: EvmChain[] }
  | { kind: "external"; chain: "solana"; address: string; coin: MarketCoinDetail };

const opts = (signal?: AbortSignal) => ({ signal });

/**
 * Finds a coin. A Solana address is looked up on the launchpad first, then as any Solana token through Jupiter. An EVM address without
 * a chain is matched through the cross-chain search, then by asking each chain.
 */
export async function resolveCoin(ctx: StealthContext, address: string, chain?: ChainKey, signal?: AbortSignal): Promise<ResolvedCoin> {
  const solana = isSolanaAddress(address);
  if (chain === "solana" || (!chain && solana)) {
    if (!solana) throw new RefusedError("invalid_input", `${address} isn't a Solana address.`);
    const token = await ctx.client.sol.tokens.find(address, opts(signal));
    if (token) return { kind: "sol", chain: "solana", address, token };
    const coin = await ctx.client.sol.market.coin(address, opts(signal)).catch((e: unknown) => {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    });
    if (coin) return { kind: "external", chain: "solana", address, coin };
    throw new NotFoundError(`No coin found at ${address} on Solana.`);
  }
  if (!isEvmTokenAddress(address)) throw new RefusedError("invalid_input", `${address} isn't an EVM address.`);
  if (chain && isEvmChain(chain)) {
    const token = await ctx.client.evm.chain(chain).findToken(address, opts(signal));
    if (!token) throw new NotFoundError(`No coin found at ${address} on ${chain}.`);
    return { kind: "evm", chain, address, token };
  }
  // the same address can be a different coin on another chain (sibling multi-chain launches share factory addresses), so ask every
  // chain, and lead with the busiest one
  const found = await Promise.allSettled(EVM_CHAIN_KEYS.map(async (c) => ({ c, t: await ctx.client.evm.chain(c).findToken(address, opts(signal)) })));
  const matches = found.flatMap((r) => (r.status === "fulfilled" && r.value.t ? [{ chain: r.value.c, token: r.value.t }] : []));
  matches.sort((x, y) => (y.token.volume24hUsd ?? 0) - (x.token.volume24hUsd ?? 0) || (y.token.holders ?? 0) - (x.token.holders ?? 0));
  const first = matches[0];
  if (first) return { kind: "evm", chain: first.chain, address, token: first.token, alsoOn: matches.slice(1).map((m) => m.chain) };
  throw new NotFoundError(`No coin found at ${address} on any EVM chain. Pass chain if you know it.`);
}

const settle = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

// ---- the report --------------------------------------------------------------------------------------------------------------

export const CoinReportSchema = {
  chain: z.string(),
  address: z.string(),
  name: z.string(),
  symbol: z.string(),
  onPlatform: z.boolean().describe("Launched on Just Stealth It. False for a Solana token read through Jupiter"),
  official: z.boolean().describe("The platform's own coin, $STEALTH"),
  stage: z.string(),
  links: z.object({ page: z.string(), explorer: nullableString }),
  market: z.object({
    priceUsd: nullableNumber,
    priceNative: nullableNumber,
    nativeSymbol: z.string(),
    marketCapUsd: nullableNumber,
    liquidityUsd: nullableNumber,
    volume24hUsd: nullableNumber,
    buys24h: nullableNumber,
    sells24h: nullableNumber,
    holders: nullableNumber,
    changePct: z.object({ m5: nullableNumber, h1: nullableNumber, h24: nullableNumber }),
    livePrice: z.boolean().describe("The price was read from the pool just now, not from the index"),
  }),
  graduation: z.object({
    progress: nullableNumber.describe("0 to 1"),
    raisedNative: nullableNumber,
    targetNative: nullableNumber,
    graduated: z.boolean(),
    graduatedAt: nullableString,
  }),
  launch: z.object({
    createdAt: nullableString,
    launcher: nullableString,
    creator: nullableString,
    venue: nullableString,
    pair: nullableString,
    taxBps: nullableNumber,
    taxTier: nullableString,
    antiSniper: z.object({
      applies: z.boolean(),
      windowSec: nullableNumber,
      open: z.boolean(),
      currentFeeBps: nullableNumber,
    }),
  }),
  launchType: z.object({ id: nullableString, label: nullableString, summary: nullableString }),
  feeRouting: z.object({
    coinBpsPerTrade: nullableNumber.describe("What the coin's launch type gets of each trade, in bps of the trade"),
    platformBpsPerTrade: nullableNumber,
    venueBpsPerTrade: nullableNumber,
    note: z.string(),
    slices: z.array(z.looseObject({ kind: z.string(), bps: z.number() })),
    creatorFees: z.object({ unclaimedNative: nullableNumber, claimedNative: nullableNumber, recipient: nullableString }).nullable(),
  }),
  risk: z.object({ holders: nullableNumber, flags: z.array(RiskFlagSchema), updatedAt: nullableString }).nullable(),
  extras: z.looseObject({}).describe("Launch-type details where they apply: buy-backs, holder rewards, multi-chain group"),
  warnings: z.array(z.string()),
};
const ReportObject = z.object(CoinReportSchema);
export type CoinReport = z.infer<typeof ReportObject>;

function solFeeRouting(t: SolTokenDetail) {
  const s = t.sol;
  const kind = s.venue ?? (s.kind === "launchlab" ? "raydium" : s.kind);
  if (kind === "pump") {
    return {
      coinBpsPerTrade: null,
      platformBpsPerTrade: null,
      venueBpsPerTrade: null,
      note: `Pump.fun sets its own fee. Of Pump's creator fee, ${PUMP_SHARES.escrowBps / 100}% goes to the coin's escrow and ${PUMP_SHARES.platformBps / 100}% to Just Stealth It, locked on chain at launch.`,
    };
  }
  const tiers = kind === "raydium" ? RAYDIUM_TIERS : METEORA_TIERS;
  const tier = tiers.find((x) => x.id === s.taxTier) ?? tiers.find((x) => x.totalBps === t.taxBps) ?? null;
  if (!tier) return { coinBpsPerTrade: null, platformBpsPerTrade: null, venueBpsPerTrade: null, note: "The coin's tax tier isn't one this server knows." };
  return {
    coinBpsPerTrade: tier.creatorBps,
    platformBpsPerTrade: tier.platformBps,
    venueBpsPerTrade: tier.protocolBps,
    note:
      kind === "raydium"
        ? "Raydium caps the creator fee at 0.5% on the curve, so the coin gets 0.5% of each trade on every tier."
        : "Meteora keeps 20% of the pool fee; the rest splits 70/30 between the coin and Just Stealth It.",
  };
}

function evmFeeRouting(taxBps: number) {
  return {
    coinBpsPerTrade: (taxBps * COIN_SHARE_BPS) / 10_000,
    platformBpsPerTrade: (taxBps * PLATFORM_SHARE_BPS) / 10_000,
    venueBpsPerTrade: 0,
    note: "The contract books 70% of the tier to the coin and 30% to Just Stealth It, locked. Anything above the tier in the anti-sniper window goes to Just Stealth It.",
  };
}

function antiSniper(createdAtMs: number | null, windowSec: number, taxBps: number, applies: boolean) {
  if (!applies || !createdAtMs) return { applies, windowSec: applies ? windowSec || 15 : null, open: false, currentFeeBps: applies ? taxBps : null };
  const elapsed = (Date.now() - createdAtMs) / 1000;
  const w = windowSec || 15;
  const open = elapsed < w;
  return { applies, windowSec: w, open, currentFeeBps: round(open ? sniperFeeBps(taxBps, elapsed) : taxBps, 2) };
}

function launchTypeBlock(id: string | null) {
  return { id, label: id ? (LAUNCH_TYPES[id]?.label ?? id) : null, summary: id ? (LAUNCH_TYPES[id]?.summary ?? null) : null };
}

export async function coinReport(ctx: StealthContext, coin: ResolvedCoin, signal?: AbortSignal): Promise<CoinReport> {
  const warnings: string[] = [];
  if (coin.kind === "external") return externalReport(ctx, coin.coin, warnings);

  const t = coin.token;
  const chain = coin.chain;
  const type = launchTypeOf(t);
  const isSol = coin.kind === "sol";
  const sol = isSol ? (t as SolTokenDetail) : null;
  const evmT = !isSol ? (t as EvmTokenDetail) : null;
  const mint = t.address;
  const wantsBuybacks = type === "buyback" || type === "mix" || type === "feed";
  const wantsRewards = type === "holders" || type === "diamond" || type === "mix";
  const evmApi = evmT ? ctx.client.evm.chain(chain as EvmChain) : null;

  const [risk, price, group, buybacks, rewards, plan] = await Promise.all([
    settle(sol ? ctx.client.sol.tokens.risk(mint, opts(signal)) : evmApi!.getRisk(mint, opts(signal))),
    sol ? settle(ctx.client.sol.tokens.price(mint, opts(signal))) : Promise.resolve(null),
    settle(ctx.client.multichain.ofCoin(chain, mint, opts(signal))),
    wantsBuybacks ? settle(sol ? ctx.client.sol.tokens.buybacks(mint, opts(signal)) : evmApi!.getBuybacks(mint, opts(signal))) : Promise.resolve(null),
    wantsRewards ? settle(sol ? ctx.client.sol.tokens.rewards(mint, opts(signal)) : evmApi!.getRewards(mint, opts(signal))) : Promise.resolve(null),
    sol ? settle(ctx.client.sol.tokens.feePlan(mint, opts(signal))) : Promise.resolve(null),
  ]);

  if (coin.kind === "evm" && coin.alsoOn?.length) warnings.push(`This address is also a separate coin on ${coin.alsoOn.join(", ")}. Pass chain to read that one.`);
  if (!risk) warnings.push("Risk figures couldn't be read right now.");
  if (sol && !sol.sol.tradable) warnings.push(sol.sol.tradeMessage ?? "This coin can't be traded here right now.");
  if (sol?.sol.external) warnings.push("Indexed by the platform, but launched elsewhere.");
  if (evmT && evmT.evm.feesRead === false) warnings.push("The fee books couldn't be read: fee figures are unknown, not zero.");
  if (t.graduation?.migrated) warnings.push("Graduation is a stage, not proof of demand.");

  const routing = sol ? solFeeRouting(sol) : evmFeeRouting(t.taxBps);
  const slices = (sol ? (plan?.plan?.slices ?? sol.sol.feePlan?.slices ?? []) : (evmT?.feePlan?.slices ?? [])).map((s) => ({ ...s, kind: s.kind, bps: s.bps }));
  const venue = venueOf(t);
  const sniperApplies = sol ? (sol.sol.venue ?? sol.sol.kind) === "meteora" : true;
  const extras: Record<string, unknown> = {};
  if (buybacks) extras.buybacks = { buys: buybacks.totals.buys, nativeSpent: buybacks.totals.solSpent, tokensBurned: buybacks.totals.tokensBurned, recent: buybacks.recent.slice(0, 5) };
  if (rewards) {
    extras.holderRewards = {
      asset: rewards.asset.symbol,
      potUsd: rewards.pot.usd,
      totalPaidUsd: rewards.totalPaid.usd,
      holdersPaid: rewards.holdersPaid,
      lastRoundAt: iso(rewards.lastRoundAt),
      nextRoundAt: iso(rewards.nextRoundAt),
      minTokens: rewards.rules.minTokens,
    };
  }
  if (group) extras.multichainGroup = { id: group.id, home: group.home, coins: group.coins, note: "Separate coins, one per chain. They aren't bridged and their numbers aren't added together." };

  const pair = sol ? (sol.sol.quoteSymbol ?? sol.sol.pair?.symbol ?? "SOL") : nativeSymbol(chain);
  return {
    chain,
    address: mint,
    name: t.name,
    symbol: t.symbol,
    onPlatform: true,
    official: sol?.sol.official === true,
    stage: t.status,
    links: { page: ctx.links.coin(mint), explorer: ctx.links.address(chain, mint) },
    market: {
      priceUsd: num(price?.priceUsd) ?? num(t.priceUsd),
      priceNative: num(price?.priceSol) ?? num(t.priceEth),
      nativeSymbol: nativeSymbol(chain),
      marketCapUsd: num(price?.marketCapUsd) ?? num(t.marketCapUsd),
      liquidityUsd: num(t.liquidityUsd),
      volume24hUsd: num(t.volume24hUsd),
      buys24h: num(t.txns24h?.buys),
      sells24h: num(t.txns24h?.sells),
      holders: num(t.holders),
      changePct: { m5: num(t.change?.m5), h1: num(t.change?.h1), h24: num(t.change?.h24) },
      livePrice: price?.live === true,
    },
    graduation: {
      progress: num(t.graduation?.progress),
      raisedNative: num(t.graduation?.raisedEth),
      targetNative: num(t.graduation?.chosenTargetEth) ?? num(t.graduation?.targetEth),
      graduated: t.graduation?.migrated === true,
      graduatedAt: iso(t.graduation?.migratedAt),
    },
    launch: {
      createdAt: iso(t.createdAt),
      launcher: str(t.launcher),
      creator: str(t.creator),
      venue,
      pair,
      taxBps: num(t.taxBps),
      taxTier: sol ? str(sol.sol.taxTier) : null,
      antiSniper: antiSniper(num(t.createdAt), t.sniperWindowSec, t.taxBps, sniperApplies),
    },
    launchType: launchTypeBlock(type),
    feeRouting: {
      ...routing,
      slices,
      creatorFees: t.fees?.creator ? { unclaimedNative: num(t.fees.creator.unclaimedEth), claimedNative: num(t.fees.creator.claimedEth), recipient: str(t.fees.creator.recipient) } : null,
    },
    risk: risk ? { holders: num(risk.holders), flags: riskFlags(risk), updatedAt: str(risk.updatedAt) } : null,
    extras,
    warnings,
  };
}

function externalReport(ctx: StealthContext, c: MarketCoinDetail, warnings: string[]): CoinReport {
  warnings.push("This token wasn't launched on Just Stealth It. Figures come from the wider Solana market and trades route through Jupiter.");
  const flags = riskFlags({ top10Pct: c.top10Pct ?? undefined, devHoldingPct: c.creatorHoldPct ?? undefined });
  return {
    chain: "solana",
    address: c.address,
    name: c.name,
    symbol: c.symbol,
    onPlatform: c.onPlatform,
    official: false,
    stage: c.onCurve ? "new" : "external",
    links: { page: ctx.links.coin(c.address), explorer: ctx.links.address("solana", c.address) },
    market: {
      priceUsd: num(c.priceUsd),
      priceNative: null,
      nativeSymbol: "SOL",
      marketCapUsd: num(c.marketCapUsd),
      liquidityUsd: num(c.liquidityUsd),
      volume24hUsd: num(c.volume24hUsd) ?? num(c.volumeUsd),
      buys24h: num(c.buys24h),
      sells24h: num(c.sells24h),
      holders: num(c.holders),
      changePct: { m5: null, h1: num(c.change1hPct), h24: num(c.change24hPct) ?? num(c.changePct) },
      livePrice: false,
    },
    graduation: { progress: num(c.curveProgress), raisedNative: null, targetNative: null, graduated: c.onCurve === false, graduatedAt: null },
    launch: {
      createdAt: iso(c.createdAt),
      launcher: str(c.launcher?.address),
      creator: str(c.creator),
      venue: str(c.launchpad),
      pair: null,
      taxBps: null,
      taxTier: null,
      antiSniper: { applies: false, windowSec: null, open: false, currentFeeBps: null },
    },
    launchType: { id: null, label: null, summary: null },
    feeRouting: { coinBpsPerTrade: null, platformBpsPerTrade: null, venueBpsPerTrade: null, note: "Set by the token's own launchpad, not by Just Stealth It.", slices: [], creatorFees: null },
    risk: { holders: num(c.holders), flags: [...flags, { line: "Sniper wallets", value: num(c.sniperWallets), level: null }, { line: "Bundler wallets", value: num(c.bundlerWallets), level: null }], updatedAt: null },
    extras: {},
    warnings,
  };
}

/** A one-line description of a report, for the text twin. */
export function reportSummary(r: CoinReport): string {
  const usd = (v: number | null) => (v === null ? "n/a" : `$${v >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toPrecision(3)}`);
  const stage = r.stage === "migrated" ? "graduated" : r.stage;
  const prog = r.graduation.progress !== null && !r.graduation.graduated ? `, ${(r.graduation.progress * 100).toFixed(1)}% to graduation` : "";
  return `${r.name} ($${r.symbol}) on ${r.chain}: ${stage}${prog}. Market cap ${usd(r.market.marketCapUsd)}, 24 h volume ${usd(r.market.volume24hUsd)}, ${r.market.holders ?? "n/a"} holders. Launch type: ${r.launchType.label ?? "n/a"}.`;
}
