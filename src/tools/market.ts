/**
 * Market reads: search, the board, the coin report, candles, trades, holders, top traders and chart events.
 *
 * @module
 */
import { CANDLE_INTERVALS, toMarketCandleInterval, type CandleInterval, type MarketChain, type MarketTrendingEntry, type TokenSortKey } from "@juststealthit/sdk/api";
import { z } from "zod";

import type { StealthContext } from "../context.js";
import { RefusedError } from "../errors.js";
import { CandleSchema, CoinSummarySchema, TradeSchema, candleRow, coinSummary, iso, nullableNumber, nullableString, num, pageSlice, readPageCursor, str, tradeRow } from "../format.js";
import { AddressSchema, ChainSchema, CoinReportSchema, coinReport, liveChainsOf, reportSummary, resolveCoin, type ResolvedCoin } from "./coins.js";
import { READ, defineTool } from "./define.js";

const SORTS = ["age", "marketCap", "volume", "liquidity", "holders", "txns", "price", "change5m", "change1h", "change24h", "progress", "lastTrade", "migrated"] as const;
const STAGE_INPUT = z.enum(["new", "graduating", "graduated"]);
const stageParam = (s: "new" | "graduating" | "graduated") => (s === "graduated" ? "migrated" : s);

/** The refusal for a launchpad-only read on an external coin, with the coin's page. */
function notOnPlatform(ctx: StealthContext, coin: ResolvedCoin, message: string) {
  return new RefusedError("not_on_platform", message, { page: ctx.links.coin(coin.address, coin.chain, false) });
}

export const searchCoins = defineTool({
  name: "search_coins",
  title: "Search coins",
  description:
    "Finds coins launched on Just Stealth It by name, ticker or address prefix, across every live chain (Solana, Robinhood Chain, BNB Chain, HyperEVM, Base, Arc). A leading $ is ignored. For coins launched elsewhere use get_trending, or get_coin_report with the address. Then get_coin_report on a result for the full picture.",
  input: {
    query: z.string().trim().min(1).max(64).describe("Name, ticker ($ optional) or the start of an address"),
    chains: z.array(ChainSchema).max(10).optional().describe("Only these chains. Default: every open chain"),
    limit: z.number().int().min(1).max(20).default(8),
  },
  output: { query: z.string(), count: z.number(), coins: z.array(CoinSummarySchema) },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const items = await ctx.client.market.search(a.query.replace(/^\$/, ""), { limit: a.limit, chains: liveChainsOf(a.chains) as MarketChain[] | undefined }, { signal });
    const coins = items.map((t) => coinSummary(t, ctx.links));
    return { data: { query: a.query, count: coins.length, coins }, summary: coins.length ? `${coins.length} match${coins.length === 1 ? "" : "es"} for "${a.query}".` : `Nothing matches "${a.query}".` };
  },
});

export const getBoard = defineTool({
  name: "get_board",
  title: "Coin board",
  description:
    "The Coins page's board: coins by stage (new, graduating, graduated) and chain, sorted and filtered the same way, paged with `cursor`. With every stage (the All list) it also mixes in external coins trending on their chains (stage external, onPlatform false); New, Graduating and Graduated are coins launched here only. Graduated means the bonding curve sold out and the coin trades in a pool.",
  input: {
    stages: z.array(STAGE_INPUT).min(1).max(3).optional().describe("Default: every stage"),
    chains: z.array(ChainSchema).max(10).optional().describe("Default: every open chain"),
    sort: z.enum(SORTS).default("age").describe("age is newest first; anything else is highest first unless dir says otherwise"),
    dir: z.enum(["asc", "desc"]).optional(),
    minMarketCapUsd: z.number().min(0).optional(),
    minVolume24hUsd: z.number().min(0).optional(),
    withSocials: z.boolean().optional().describe("Only coins with at least one social link"),
    query: z.string().trim().max(64).optional().describe("Filter by name, ticker or address prefix"),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(512).optional().describe("nextCursor from the previous call"),
    withCounts: z.boolean().default(false).describe("Also return how many coins sit in each stage and chain"),
  },
  output: {
    coins: z.array(CoinSummarySchema),
    nextCursor: nullableString.describe("Pass as cursor for the next coins; null at the end"),
    truncated: z.number().describe("Coins after these on the API's current page, which nextCursor reaches first"),
    total: nullableNumber,
    counts: z.looseObject({}).nullable(),
  },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const filters = { q: a.query, mcap: a.minMarketCapUsd, vol: a.minVolume24hUsd, socials: a.withSocials, chains: liveChainsOf(a.chains) as MarketChain[] | undefined };
    const at = readPageCursor(a.cursor);
    const [page, counts] = await Promise.all([
      ctx.client.market.list({ ...filters, stages: a.stages?.map(stageParam) as never, sort: a.sort as TokenSortKey, dir: a.dir, cursor: at.api }, { signal }),
      a.withCounts ? ctx.client.market.counts(filters, { signal }) : Promise.resolve(null),
    ]);
    // a limit under the API's page size must not skip the rest of that page
    const { shown, left, nextCursor } = pageSlice(page.items, at.skip, a.limit, at.api, page.nextCursor);
    const coins = shown.map((t) => coinSummary(t, ctx.links));
    return {
      data: { coins, nextCursor, truncated: left, total: num(page.total), counts: counts as Record<string, unknown> | null },
      summary: `${coins.length} coin${coins.length === 1 ? "" : "s"}, sorted by ${a.sort}.${nextCursor ? " Pass nextCursor as cursor for more." : ""}`,
    };
  },
});

export const getCoinReport = defineTool({
  name: "get_coin_report",
  title: "Coin report",
  description:
    "The best first call for any coin. Everything about it: price, market cap, volume, holders, graduation progress, venue and pair, tax and anti-sniper state, launch type and where its creator fees go, holder-concentration risk with the token page's green/amber/red bands, and buy-backs, holder rewards or multi-chain siblings where they apply. Also works for coins launched elsewhere (any Solana token, or a coin trending on a live EVM chain): those get market figures, risk and their page.",
  input: {
    address: AddressSchema,
    chain: ChainSchema.optional().describe("Speeds up EVM lookups. Solana addresses don't need it"),
  },
  output: CoinReportSchema,
  annotations: READ,
  async run(a, { ctx, signal }) {
    const coin = await resolveCoin(ctx, a.address, a.chain, signal);
    const report = await coinReport(ctx, coin, signal);
    return { data: report, summary: reportSummary(report) };
  },
});

// the platform's candle sizes, from the SDK: 1 minute is the smallest (the 1 second interval is gone)
const INTERVALS = CANDLE_INTERVALS as readonly CandleInterval[] as readonly [CandleInterval, ...CandleInterval[]];

export const getCandles = defineTool({
  name: "get_candles",
  title: "Price candles",
  description:
    "OHLC candles for a coin, oldest first, from 1 minute to 1 day. A candle only forms when someone trades, so quiet stretches have none. Coins launched here are priced in the pair's native coin (SOL, ETH, BNB, HYPE or USDC) with volume in USD; external coins (any other Solana token, or a coin trending on an EVM chain) are priced in USD, and `to` pages back through their history. Use the latest candles to describe a trend, not to predict one.",
  input: {
    address: AddressSchema,
    chain: ChainSchema.optional(),
    interval: z.enum(INTERVALS).default("15m"),
    from: z.number().int().positive().optional().describe("Unix seconds. Default: a day before `to`"),
    to: z.number().int().positive().optional().describe("Unix seconds. Default: now"),
    limit: z.number().int().min(1).max(500).default(120).describe("The most recent N candles of the range"),
  },
  output: { chain: z.string(), address: z.string(), interval: z.string(), priceUnit: z.string(), volumeUnit: z.string(), count: z.number(), candles: z.array(CandleSchema) },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const coin = await resolveCoin(ctx, a.address, a.chain, signal);
    const range = { interval: a.interval as CandleInterval, from: a.from, to: a.to };
    let rows: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
    let priceUnit: string;
    if (coin.kind === "sol") {
      rows = (await ctx.client.sol.tokens.candles(coin.address, range, { signal })).map(candleRow);
      priceUnit = coin.token.sol.quoteSymbol ?? "SOL";
    } else if (coin.kind === "evm") {
      rows = (await ctx.client.evm.chain(coin.chain).getCandles(coin.address, range, { signal })).map(candleRow);
      priceUnit = coin.token.evm.native;
    } else {
      const market = await ctx.client.sol.market.candles(coin.address, toMarketCandleInterval(a.interval), { ...(coin.chain === "solana" ? {} : { chain: coin.chain }), to: a.to }, { signal });
      rows = market.filter((c) => a.from === undefined || c.time >= a.from).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: num(c.volumeUsd) ?? 0 }));
      priceUnit = "USD";
    }
    const candles = rows.slice(-a.limit);
    const last = candles[candles.length - 1];
    return {
      data: { chain: coin.chain, address: coin.address, interval: a.interval, priceUnit, volumeUnit: "USD", count: candles.length, candles },
      summary: last ? `${candles.length} ${a.interval} candles; last close ${last.close} ${priceUnit} at ${new Date(last.time * 1000).toISOString()}.` : "No candles in that range.",
    };
  },
});

export const getTrades = defineTool({
  name: "get_trades",
  title: "Recent trades",
  description: "A launchpad coin's trades, newest first, 50 per page: side, value, amounts, trader, transaction, and whether the trade paid the anti-sniper fee or was the launcher's first buy.",
  input: {
    address: AddressSchema,
    chain: ChainSchema.optional(),
    limit: z.number().int().min(1).max(50).default(25),
    cursor: z.string().max(512).optional().describe("nextCursor from the previous call, for older trades"),
  },
  output: { chain: z.string(), address: z.string(), trades: z.array(TradeSchema), nextCursor: nullableString, truncated: z.number(), buys: z.number(), sells: z.number(), volumeUsd: z.number() },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const coin = await resolveCoin(ctx, a.address, a.chain, signal);
    if (coin.kind === "external") throw notOnPlatform(ctx, coin, "Trades are listed for coins launched here only. get_coin_report has this coin's market figures.");
    const at = readPageCursor(a.cursor);
    const page = coin.kind === "sol" ? await ctx.client.sol.tokens.trades(coin.address, at.api, { signal }) : await ctx.client.evm.chain(coin.chain).getTrades(coin.address, at.api, { signal });
    const { shown, left, nextCursor } = pageSlice(page.items, at.skip, a.limit, at.api, page.nextCursor);
    const trades = shown.map(tradeRow);
    const buys = trades.filter((t) => t.side === "buy").length;
    const volumeUsd = trades.reduce((n, t) => n + (t.valueUsd ?? 0), 0);
    return {
      data: { chain: coin.chain, address: coin.address, trades, nextCursor, truncated: left, buys, sells: trades.length - buys, volumeUsd: Number(volumeUsd.toFixed(2)) },
      summary: `${trades.length} trades: ${buys} buys, ${trades.length - buys} sells, $${volumeUsd.toFixed(0)} in all.`,
    };
  },
});

export const getHolders = defineTool({
  name: "get_holders",
  title: "Top holders",
  description: "A launchpad coin's largest holders with their share of supply. The pool, escrow, creator, locks, snipers and burn address are labelled; the pools and the platform's own wallets don't count as holders.",
  input: { address: AddressSchema, chain: ChainSchema.optional(), limit: z.number().int().min(1).max(50).default(20) },
  output: {
    chain: z.string(),
    address: z.string(),
    holders: z.array(z.object({ address: z.string(), balance: nullableNumber, pctOfSupply: nullableNumber, valueUsd: nullableNumber, label: nullableString })),
    top10PctExcludingLabelled: z.number(),
  },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const coin = await resolveCoin(ctx, a.address, a.chain, signal);
    if (coin.kind === "external") throw notOnPlatform(ctx, coin, "Holder lists are kept for coins launched here only. get_coin_report has this coin's top-10 share.");
    const rows = coin.kind === "sol" ? await ctx.client.sol.tokens.holders(coin.address, { signal }) : await ctx.client.evm.chain(coin.chain).getHolders(coin.address, { signal });
    const holders = rows.slice(0, a.limit).map((h) => ({ address: h.address, balance: num(h.balance), pctOfSupply: num(h.pctOfSupply), valueUsd: num(h.valueUsd), label: str(h.label) }));
    const plain = rows.filter((h) => !h.label || h.label === "creator" || h.label === "sniper").slice(0, 10);
    const top10 = Number(plain.reduce((n, h) => n + (h.pctOfSupply ?? 0), 0).toFixed(2));
    return { data: { chain: coin.chain, address: coin.address, holders, top10PctExcludingLabelled: top10 }, summary: `Top 10 wallets (pools, escrows and burns aside) hold ${top10}% of supply.` };
  },
});

export const getTopTraders = defineTool({
  name: "get_top_traders",
  title: "Top traders",
  description: "A launchpad coin's traders ranked by PnL: bought, sold, unrealized value and PnL in the native coin and USD. Past PnL says nothing about what comes next.",
  input: { address: AddressSchema, chain: ChainSchema.optional(), limit: z.number().int().min(1).max(30).default(10) },
  output: {
    chain: z.string(),
    address: z.string(),
    traders: z.array(
      z.object({ address: z.string(), trades: nullableNumber, boughtNative: nullableNumber, soldNative: nullableNumber, unrealizedNative: nullableNumber, pnlNative: nullableNumber, pnlUsd: nullableNumber }),
    ),
  },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const coin = await resolveCoin(ctx, a.address, a.chain, signal);
    if (coin.kind === "external") throw notOnPlatform(ctx, coin, "Top traders are kept for coins launched here only.");
    const rows = coin.kind === "sol" ? await ctx.client.sol.tokens.topTraders(coin.address, { signal }) : await ctx.client.evm.chain(coin.chain).getTopTraders(coin.address, { signal });
    const traders = rows.slice(0, a.limit).map((t) => ({
      address: t.address,
      trades: num(t.trades),
      boughtNative: num(t.boughtEth),
      soldNative: num(t.soldEth),
      unrealizedNative: num(t.unrealizedEth),
      pnlNative: num(t.pnlEth),
      pnlUsd: num(t.pnlUsd),
    }));
    return { data: { chain: coin.chain, address: coin.address, traders } };
  },
});

export const getChartEvents = defineTool({
  name: "get_chart_events",
  title: "Chart events",
  description:
    "The bubbles on a coin's chart, oldest first: the launcher's buys and sells, platform events (burns, graduation, marketing steps, claims), Feed callouts naming the coin, and posts on X that reached the Stealth agent.",
  input: {
    address: AddressSchema,
    symbol: z.string().regex(/^[A-Za-z0-9]{1,12}$/).optional().describe("Also match $CASHTAG posts for this ticker"),
    kinds: z.array(z.enum(["dev", "event", "callout", "x"])).optional(),
    limit: z.number().int().min(1).max(200).default(50).describe("The most recent N"),
  },
  output: {
    address: z.string(),
    events: z.array(z.object({ at: nullableString, kind: z.string(), sub: z.string(), who: nullableString, text: nullableString, link: nullableString, native: nullableNumber })),
  },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const rows = await ctx.client.platform.chartEvents(a.address, a.symbol, { signal });
    const events = rows
      .filter((e) => !a.kinds || a.kinds.includes(e.kind))
      .slice(-a.limit)
      .map((e) => ({ at: iso(e.at), kind: e.kind, sub: e.sub, who: str(e.who), text: str(e.text), link: str(e.link), native: num(e.sol) }));
    return { data: { address: a.address, events }, summary: `${events.length} chart events.` };
  },
});

export const TrendingCoinSchema = z.object({
  rank: z.number(),
  chain: z.string(),
  address: z.string(),
  symbol: z.string(),
  name: z.string(),
  priceUsd: nullableNumber,
  marketCapUsd: nullableNumber,
  changePct: nullableNumber.describe("Percent: 24 h for coins launched here, 1 h for external coins, as the site's Trending shows them"),
  volume1hUsd: nullableNumber,
  onPlatform: z.boolean().describe("Launched on Just Stealth It"),
  launchpad: nullableString.describe("For an external coin: the launchpad it came from"),
  official: z.boolean().describe("$STEALTH itself"),
  url: z.string(),
});

/** One row of the cross-chain Trending list, as the tool and the resource show it. */
export function trendingRow(ctx: StealthContext, c: MarketTrendingEntry, i: number): z.infer<typeof TrendingCoinSchema> {
  return {
    rank: i + 1,
    chain: c.chain,
    address: c.address,
    symbol: c.symbol,
    name: c.name,
    priceUsd: num(c.priceUsd),
    marketCapUsd: num(c.marketCapUsd),
    changePct: num(c.changePct),
    volume1hUsd: num(c.volume1hUsd),
    onPlatform: c.onPlatform,
    launchpad: str(c.launchpad),
    official: c.official === true,
    url: ctx.links.coin(c.address, c.chain, c.onPlatform),
  };
}

export const getTrending = defineTool({
  name: "get_trending",
  title: "Trending coins",
  description:
    "What's trending right now across chains, as the site's Trending shows it: coins launched on Just Stealth It mixed with external coins trending on Solana and the other live chains (Solana first). Use this for \"what's hot\" questions; get_board lists coins launched here by stage, search_coins finds one by name. External coins passed filters meant to keep out noise, which doesn't make them safe; trending is activity, not quality.",
  input: {
    chains: z.array(ChainSchema).max(10).optional().describe("Only these chains. Default: every live chain"),
    source: z.enum(["all", "launched_here", "external"]).default("all").describe("launched_here: only coins launched on Just Stealth It; external: only coins from elsewhere"),
    limit: z.number().int().min(1).max(50).default(20),
  },
  output: {
    coins: z.array(TrendingCoinSchema),
    externalIncluded: z.boolean().describe("False when the external-coin feed is off or unavailable right now: the list is then coins launched here only"),
  },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const t = await ctx.client.market.trending({ chains: liveChainsOf(a.chains) as MarketChain[] | undefined }, { signal });
    const picked = t.coins.filter((c) => a.source === "all" || (a.source === "launched_here" ? c.onPlatform : !c.onPlatform));
    const coins = picked.slice(0, a.limit).map((c, i) => trendingRow(ctx, c, i));
    const external = coins.filter((c) => !c.onPlatform).length;
    return {
      data: { coins, externalIncluded: t.outside },
      summary: `${coins.length} trending coin${coins.length === 1 ? "" : "s"}: ${coins.length - external} launched here, ${external} external.${t.outside ? "" : " External coins aren't available right now."}`,
    };
  },
});

export const marketTools = [searchCoins, getBoard, getTrending, getCoinReport, getCandles, getTrades, getHolders, getTopTraders, getChartEvents];
