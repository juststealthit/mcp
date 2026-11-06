/**
 * Quotes and fee maths: a live quote for any coin, the anti-sniper line, how a fee splits on each venue, and offline bonding-curve
 * previews. The maths is the SDK's, which mirrors the contracts and the published docs.
 *
 * @module
 */
import {
  COIN_SHARE_BPS,
  PLATFORM_SHARE_BPS,
  SNIPER_WINDOW_SEC,
  TAX_TIERS_BPS,
  curveProgress,
  feeTable,
  initCurve,
  quoteCurveBuy,
  quoteCurveSell,
  quoteToGraduate,
  sniperFeeBps,
  sniperSchedule,
  splitEvmFee,
  splitPumpCreatorFee,
  splitTierFee,
  type CurveState,
} from "@juststealthit/sdk/math";
import { METEORA_TIERS, RAYDIUM_TIERS } from "@juststealthit/sdk/solana";
import { formatUnits, parseUnits } from "@juststealthit/sdk/utils";
import { z } from "zod";

import { RefusedError } from "../errors.js";
import { nullableNumber, nullableString, num, round, short } from "../format.js";
import { AddressSchema, ChainSchema, resolveCoin, tradeOnSite } from "./coins.js";
import { PURE, READ, defineTool } from "./define.js";

export const DecimalAmount = z
  .string()
  .trim()
  .regex(/^\d{1,30}(\.\d{1,18})?$/, "a positive decimal such as 0.5")
  .refine((s) => Number(s) > 0, "must be above 0");
const BaseUnits = z.string().regex(/^\d{1,40}$/, "an integer number of base units");

const Amount = z.object({ raw: z.string(), amount: z.string(), unit: z.string() });

export const quoteTrade = defineTool({
  name: "quote_trade",
  title: "Quote a trade",
  description:
    "A live quote for buying or selling a coin, read from its pool now: what you'd get, the least the slippage allows, the fee charged right now (the tax, or the anti-sniper fee in a coin's first seconds) and the price impact. A quote, not an order: prices move and nothing is reserved.",
  input: {
    address: AddressSchema,
    chain: ChainSchema.optional(),
    side: z.enum(["buy", "sell"]),
    amount: DecimalAmount.describe("Buy: the native coin to spend (SOL, ETH, BNB, HYPE or USDC). Sell: whole tokens to sell"),
    slippageBps: z.number().int().min(10).max(5_000).optional().describe("Default: config.json's slippageBps, else 300"),
  },
  output: {
    chain: z.string(),
    address: z.string(),
    symbol: z.string(),
    route: z.string(),
    side: z.string(),
    amountIn: Amount,
    amountOut: Amount,
    minAmountOut: Amount,
    feeBps: nullableNumber,
    priceImpactPct: nullableNumber,
    slippageBps: z.number(),
  },
  annotations: { ...READ, idempotentHint: false },
  async run(a, { ctx, signal }) {
    const coin = await resolveCoin(ctx, a.address, a.chain, signal);
    if (coin.kind === "external" && coin.chain !== "solana") throw tradeOnSite(ctx, coin);
    const slippage = a.slippageBps ?? ctx.config.slippageBps;
    const nativeDec = coin.chain === "solana" ? 9 : 18;
    const native = coin.kind === "evm" ? coin.token.evm.native : "SOL";
    const tokenDec = coin.kind === "external" ? (coin.coin.decimals ?? null) : coin.kind === "sol" ? (coin.token.decimals ?? 6) : 18;
    if (tokenDec === null) throw new RefusedError("unknown_decimals", "This token's decimals aren't known, so the amount can't be converted.");
    const symbol = coin.kind === "external" ? coin.coin.symbol : coin.token.symbol;
    const [inDec, outDec, inUnit, outUnit] = a.side === "buy" ? [nativeDec, tokenDec, native, symbol] : [tokenDec, nativeDec, symbol, native];
    const raw = parseUnits(a.amount, inDec);
    const fmt = (v: string, d: number, unit: string) => ({ raw: v, amount: formatUnits(BigInt(v), d), unit });

    let route: string;
    let q: { amountIn: string; amountOut: string; minAmountOut: string; feeBps: number | null; priceImpactPct: number | null };
    if (coin.kind === "evm") {
      const r = await ctx.client.evm.chain(coin.chain).quote(coin.address, a.side, raw, slippage, { signal });
      route = "pool";
      q = { ...r, feeBps: r.feeBps };
    } else if (coin.kind === "sol" && coin.token.sol.swapVia === "app") {
      const r = await ctx.client.sol.quote(coin.address, a.side, raw, slippage, { signal });
      route = r.venue === "curve" ? "bonding curve" : "pool";
      q = { ...r, feeBps: r.feeBps };
    } else {
      if (coin.kind === "sol" && coin.token.sol.swapVia === null) throw new RefusedError("not_tradable", coin.token.sol.tradeMessage ?? "This coin can't be traded here right now.");
      const r = await ctx.client.sol.market.quote(coin.address, a.side, raw, slippage, { signal });
      route = `Jupiter${r.route.length ? ` (${r.route.join(" → ")})` : ""}`;
      q = { amountIn: r.amountIn, amountOut: r.amountOut, minAmountOut: r.minAmountOut, feeBps: null, priceImpactPct: r.priceImpactPct };
    }
    const data = {
      chain: coin.chain,
      address: coin.address,
      symbol,
      route,
      side: a.side,
      amountIn: fmt(q.amountIn, inDec, inUnit),
      amountOut: fmt(q.amountOut, outDec, outUnit),
      minAmountOut: fmt(q.minAmountOut, outDec, outUnit),
      feeBps: num(q.feeBps),
      priceImpactPct: num(q.priceImpactPct),
      slippageBps: slippage,
    };
    const fee = data.feeBps === null ? "" : ` Fee now ${(data.feeBps / 100).toFixed(2)}%${data.feeBps > 1_000 ? " (anti-sniper window: wait a few seconds)" : ""}.`;
    return { data, summary: `${short(data.amountIn.amount)} ${inUnit} → about ${short(data.amountOut.amount)} ${outUnit} via ${route}, at least ${short(data.minAmountOut.amount)}.${fee}` };
  },
});

export const calcSniperFee = defineTool({
  name: "calc_sniper_fee",
  title: "Anti-sniper fee",
  description:
    "The anti-sniper fee on Meteora and EVM launches: 90% at launch, stepping down each whole second to the coin's tax at 15 s, on buys and sells alike. Give a tier and seconds since launch, or a coin's address to read both. Pump.fun and Raydium LaunchLab coins have no such fee.",
  input: {
    tierBps: z.union([z.literal(125), z.literal(225), z.literal(325), z.literal(425), z.literal(575)]).optional().describe("The coin's tax tier in bps: 125, 225, 325, 425 or 575"),
    secondsSinceLaunch: z.number().min(0).max(1e9).optional(),
    address: AddressSchema.optional().describe("Read the tier and launch time from this coin"),
    chain: ChainSchema.optional(),
  },
  output: {
    tierBps: z.number(),
    secondsSinceLaunch: nullableNumber,
    feeBps: nullableNumber,
    feePct: nullableNumber,
    windowOpen: z.boolean(),
    secondsLeft: z.number(),
    applies: z.boolean(),
    schedule: z.array(z.object({ second: z.number(), feePct: z.number() })),
    coin: nullableString,
  },
  annotations: { ...PURE, openWorldHint: true },
  async run(a, { ctx, signal }) {
    let tier: number | undefined = a.tierBps;
    let elapsed: number | undefined = a.secondsSinceLaunch;
    let applies = true;
    let coinName: string | null = null;
    if (a.address) {
      const coin = await resolveCoin(ctx, a.address, a.chain, signal);
      if (coin.kind === "external") throw new RefusedError("not_on_platform", "This token wasn't launched here, so the platform's anti-sniper fee doesn't apply.");
      tier ??= coin.token.taxBps;
      elapsed ??= (Date.now() - coin.token.createdAt) / 1000;
      coinName = coin.token.symbol;
      if (coin.kind === "sol") applies = (coin.token.sol.venue ?? coin.token.sol.kind) === "meteora";
    }
    if (tier === undefined) throw new RefusedError("invalid_input", "Give tierBps, or a coin's address.");
    const open = applies && elapsed !== undefined && elapsed < SNIPER_WINDOW_SEC;
    const feeBps = elapsed === undefined ? null : applies ? round(sniperFeeBps(tier, elapsed), 2) : tier;
    return {
      data: {
        tierBps: tier,
        secondsSinceLaunch: elapsed === undefined ? null : round(elapsed, 1),
        feeBps,
        feePct: feeBps === null ? null : round(feeBps / 100, 4),
        windowOpen: open,
        secondsLeft: open ? round(SNIPER_WINDOW_SEC - elapsed!, 1)! : 0,
        applies,
        schedule: applies ? sniperSchedule(tier).map((r) => ({ second: r.second, feePct: round(r.feeBps / 100, 2)! })) : [],
        coin: coinName,
      },
      summary: !applies ? "This venue has no anti-sniper fee." : feeBps === null ? `From 90% at launch down to ${tier / 100}% at 15 s.` : `${(feeBps / 100).toFixed(2)}% right now${open ? `, falling to ${tier / 100}% in ${(SNIPER_WINDOW_SEC - elapsed!).toFixed(0)} s` : ""}.`,
    };
  },
});

export const calcFeeSplit = defineTool({
  name: "calc_fee_split",
  title: "Fee split",
  description:
    "How a trade's fee splits between the coin's launch type (creator fees), Just Stealth It and the venue, for a venue and tax tier, the way the contracts and venue configs book it. Optionally for an amount. Also returns the docs' full table of what a coin gets per tier on each venue. Fees depend entirely on trading.",
  input: {
    venue: z.enum(["evm", "meteora", "raydium", "pump"]),
    tierBps: z.number().int().optional().describe("125, 225, 325, 425 or 575. Not used for pump"),
    amount: DecimalAmount.optional().describe("Trade size in the pair token (pump: the creator fee itself)"),
    decimals: z.number().int().min(0).max(18).default(9).describe("Decimals of the pair token. SOL 9, EVM natives 18"),
    chargedBps: z.number().min(0).max(9_000).optional().describe("What the trade was charged, if above the tier (anti-sniper)"),
  },
  output: {
    venue: z.string(),
    tierBps: nullableNumber,
    perTradeBps: z.object({ coin: nullableNumber, platform: nullableNumber, venue: nullableNumber, total: nullableNumber }),
    amounts: z.object({ total: z.string(), coin: z.string(), platform: z.string(), venue: z.string() }).nullable(),
    note: z.string(),
    table: z.array(z.object({ tierBps: z.number(), evm: z.number(), meteora: z.number(), raydium: z.number() })),
  },
  annotations: PURE,
  async run(a) {
    const table = feeTable();
    const raw = a.amount ? parseUnits(a.amount, a.decimals) : null;
    const f = (v: bigint) => formatUnits(v, a.decimals);
    if (a.venue === "pump") {
      const split = raw === null ? null : splitPumpCreatorFee(raw);
      return {
        data: {
          venue: "pump",
          tierBps: null,
          perTradeBps: { coin: null, platform: null, venue: null, total: null },
          amounts: split && raw !== null ? { total: f(raw), coin: f(split.coin), platform: f(split.platform), venue: "0" } : null,
          note: "Pump.fun sets its own fee and can change it. Of Pump's creator fee, 70% goes to the coin's escrow and 30% to Just Stealth It, locked on chain at launch.",
          table,
        },
      };
    }
    const tierBps = a.tierBps ?? 125;
    if (!(TAX_TIERS_BPS as readonly number[]).includes(tierBps)) throw new RefusedError("invalid_input", `tierBps is one of ${TAX_TIERS_BPS.join(", ")}.`);
    if (a.venue === "evm") {
      const split = raw === null ? null : splitEvmFee(raw, tierBps, a.chargedBps);
      return {
        data: {
          venue: "evm",
          tierBps,
          perTradeBps: { coin: (tierBps * COIN_SHARE_BPS) / 10_000, platform: ((a.chargedBps ?? tierBps) * 10_000 - tierBps * COIN_SHARE_BPS) / 10_000, venue: 0, total: a.chargedBps ?? tierBps },
          amounts: split ? { total: f(split.total), coin: f(split.coin), platform: f(split.platform), venue: f(split.protocol) } : null,
          note: `The contract books ${COIN_SHARE_BPS / 100}% of the tier to the coin and ${PLATFORM_SHARE_BPS / 100}% to Just Stealth It, locked. Anything above the tier goes to Just Stealth It, so self-sniping gains a launcher nothing.`,
          table,
        },
      };
    }
    const tiers = a.venue === "raydium" ? RAYDIUM_TIERS : METEORA_TIERS;
    const tier = tiers.find((t) => t.totalBps === tierBps)!;
    const split = raw === null ? null : splitTierFee(raw, tier, a.chargedBps);
    return {
      data: {
        venue: a.venue,
        tierBps,
        perTradeBps: { coin: tier.creatorBps, platform: tier.platformBps, venue: tier.protocolBps, total: tier.totalBps },
        amounts: split ? { total: f(split.total), coin: f(split.coin), platform: f(split.platform), venue: f(split.protocol) } : null,
        note:
          a.venue === "raydium"
            ? "Raydium caps the creator fee at 0.5% on the curve, so the coin gets 0.5% of each trade on every tier and higher tiers add only to Just Stealth It's share."
            : "Meteora keeps 20% of the pool fee; the rest splits 70/30 between the coin and Just Stealth It, the anti-sniper surplus included.",
        table,
      },
    };
  },
});

const CurveInput = z.object({ virtualToken: BaseUnits, virtualQuote: BaseUnits, realToken: BaseUnits, realQuote: BaseUnits, totalSellToken: BaseUnits });
const InitInput = z.object({ supply: BaseUnits, totalSell: BaseUnits, raise: BaseUnits, locked: BaseUnits.optional(), migrateFee: BaseUnits.optional() });

export const calcCurveQuote = defineTool({
  name: "calc_curve_quote",
  title: "Bonding-curve preview",
  description:
    "An offline preview on a constant-product bonding curve with virtual reserves (the model Pump.fun and Raydium LaunchLab curves follow): tokens for a buy or quote for a sell, the fee, price impact, progress after, and what's left to graduate. Give the curve's reserves, or the launch parameters to derive a fresh one. All amounts in base units. Meteora's curve differs: use quote_trade to act.",
  input: {
    side: z.enum(["buy", "sell"]),
    amount: BaseUnits.describe("Buy: quote base units in, fee included. Sell: token base units in"),
    feeBps: z.number().min(0).max(9_999).describe("The fee rate charged on this trade"),
    curve: CurveInput.optional(),
    init: InitInput.optional().describe("Derive a fresh curve: supply, tokens sold on the curve, and what the curve raises"),
  },
  output: {
    amountIn: z.string(),
    amountOut: z.string(),
    fee: z.string(),
    priceBefore: z.number(),
    priceAfter: z.number(),
    priceImpactPct: z.number(),
    progressAfter: z.number(),
    quoteToGraduateAfter: z.string(),
    note: z.string(),
  },
  annotations: PURE,
  async run(a) {
    let s: CurveState;
    if (a.curve) {
      s = { virtualToken: BigInt(a.curve.virtualToken), virtualQuote: BigInt(a.curve.virtualQuote), realToken: BigInt(a.curve.realToken), realQuote: BigInt(a.curve.realQuote), totalSellToken: BigInt(a.curve.totalSellToken) };
    } else if (a.init) {
      s = initCurve({ supply: BigInt(a.init.supply), totalSell: BigInt(a.init.totalSell), raise: BigInt(a.init.raise), locked: a.init.locked ? BigInt(a.init.locked) : undefined, migrateFee: a.init.migrateFee ? BigInt(a.init.migrateFee) : undefined });
    } else throw new RefusedError("invalid_input", "Give curve (the reserves) or init (launch parameters).");
    const before = Number(s.virtualQuote + s.realQuote) / Number(s.virtualToken - s.realToken);
    const q = a.side === "buy" ? quoteCurveBuy(s, BigInt(a.amount), a.feeBps) : quoteCurveSell(s, BigInt(a.amount), a.feeBps);
    return {
      data: {
        amountIn: q.amountIn.toString(),
        amountOut: q.amountOut.toString(),
        fee: q.fee.toString(),
        priceBefore: before,
        priceAfter: q.priceAfter,
        priceImpactPct: Number(q.priceImpactPct.toFixed(6)),
        progressAfter: curveProgress(q.after),
        quoteToGraduateAfter: quoteToGraduate(q.after, a.feeBps).toString(),
        note: "A preview. The chain's state at the moment you trade has the last word.",
      },
    };
  },
});

export const mathTools = [quoteTrade, calcSniperFee, calcFeeSplit, calcCurveQuote];
