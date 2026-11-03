/**
 * Market reads: search, the board, the coin report, candles, trades, holders, top traders and chart events.
 *
 * @module
 */
import type { CandleInterval, MarketChain, TokenSortKey } from "@juststealthit/sdk/api";
import { z } from "zod";

import { RefusedError } from "../errors.js";
import { CandleSchema, CoinSummarySchema, TradeSchema, candleRow, coinSummary, iso, nullableNumber, nullableString, num, str, tradeRow } from "../format.js";
import { AddressSchema, ChainSchema, CoinReportSchema, coinReport, reportSummary, resolveCoin } from "./coins.js";
import { READ, defineTool } from "./define.js";

const SORTS = ["age", "marketCap", "volume", "liquidity", "holders", "txns", "price", "change5m", "change1h", "change24h", "progress", "lastTrade", "migrated"] as const;
const STAGE_INPUT = z.enum(["new", "graduating", "graduated"]);
const stageParam = (s: "new" | "graduating" | "graduated") => (s === "graduated" ? "migrated" : s);

export const searchCoins = defineTool({
  name: "search_coins",
  title: "Search coins",
  description:
    "Finds launchpad coins by name, ticker or address prefix across every chain (Solana, Robinhood Chain, BNB Chain, HyperEVM, Base, Arc). A leading $ is ignored. Use get_coin_report on a result for the full picture.",
  input: {
    query: z.string().trim().min(1).max(64).describe("Name, ticker ($ optional) or the start of an address"),
    chains: z.array(ChainSchema).max(6).optional().describe("Only these chains. Default: every open chain"),
    limit: z.number().int().min(1).max(20).default(8),
  },
  output: { query: z.string(), count: z.number(), coins: z.array(CoinSummarySchema) },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const items = await ctx.client.market.search(a.query.replace(/^\$/, ""), { limit: a.limit, chains: a.chains as MarketChain[] | undefined }, { signal });
    const coins = items.map((t) => coinSummary(t, ctx.links));
    return { data: { query: a.query, count: coins.length, coins }, summary: coins.length ? `${coins.length} match${coins.length === 1 ? "" : "es"} for "${a.query}".` : `Nothing matches "${a.query}".` };
  },
});

export const getBoard = defineTool({
  name: "get_board",
  title: "Coin board",
  description:
    "The launchpad's board: coins by stage (new, graduating, graduated) and chain, sorted and filtered like the Coins page. Pages through with `cursor`. Graduated means the bonding curve sold out and the coin trades in a pool.",
  input: {
    stages: z.array(STAGE_INPUT).min(1).max(3).optional().describe("Default: every stage"),
    chains: z.array(ChainSchema).max(6).optional().describe("Default: every open chain"),
    sort: z.enum(SORTS).default("age").describe("age is newest first; anything else is highest first unless dir says otherwise"),
    dir: z.enum(["asc", "desc"]).optional(),
    minMarketCapUsd: z.number().min(0).optional(),
    minVolume24hUsd: z.number().min(0).optional(),
    withSocials: z.boolean().optional().describe("Only coins with at least one social link"),
    query: z.string().trim().max(64).optional().describe("Filter by name, ticker or address prefix"),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(512).optional().describe("nextCursor from the previous page"),
    withCounts: z.boolean().default(false).describe("Also return how many coins sit in each stage and chain"),
  },
  output: {
    coins: z.array(CoinSummarySchema),
    nextCursor: nullableString,
    truncated: z.number().describe("Coins on this page left out by limit"),
    total: nullableNumber,
    counts: z.looseObject({}).nullable(),
  },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const filters = { q: a.query, mcap: a.minMarketCapUsd, vol: a.minVolume24hUsd, socials: a.withSocials, chains: a.chains as MarketChain[] | undefined };
    const [page, counts] = await Promise.all([
      ctx.client.market.list({ ...filters, stages: a.stages?.map(stageParam) as never, sort: a.sort as TokenSortKey, dir: a.dir, cursor: a.cursor }, { signal }),
      a.withCounts ? ctx.client.market.counts(filters, { signal }) : Promise.resolve(null),
    ]);
    const coins = page.items.slice(0, a.limit).map((t) => coinSummary(t, ctx.links));
    return {
      data: { coins, nextCursor: page.nextCursor, truncated: Math.max(0, page.items.length - a.limit), total: num(page.total), counts: counts as Record<string, unknown> | null },
      summary: `${coins.length} coin${coins.length === 1 ? "" : "s"}, sorted by ${a.sort}.${page.items.length > a.limit ? " Raise limit (up to 50) to see the rest of this page." : ""}`,
    };
  },
});

export const getCoinReport = defineTool({
  name: "get_coin_report",
  title: "Coin report",
  description:
    "Everything about one coin: price, market cap, volume, holders, graduation progress, venue and pair, tax and anti-sniper state, launch type and where its creator fees go, holder-concentration risk with the token page's green/amber/red bands, and buy-backs, holder rewards or multi-chain siblings where they apply. Works for any Solana token; non-launchpad tokens get market figures only.",
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

const INTERVALS = ["1s", "1m", "5m", "15m", "1h", "4h", "1D"] as const;

export const getCandles = defineTool({
  name: "get_candles",
  title: "Price candles",
  description:
    "OHLC candles for a coin, oldest first. Launchpad coins are priced in the pair's native coin (SOL, ETH, BNB, HYPE or USDC) with volume in USD; other Solana tokens are priced in USD. Use the latest candles to describe a trend, not to predict one.",
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
      if (a.interval === "1s") throw new RefusedError("invalid_input", "1s candles exist for launchpad coins only. Use 1m or longer.");
      const iv = (a.interval === "1D" ? "1d" : a.interval) as "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
      rows = (await ctx.client.sol.market.candles(coin.address, iv, { signal })).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: num(c.volumeUsd) ?? 0 }));
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
    cursor: z.string().max(512).optional(),
  },
  output: { chain: z.string(), address: z.string(), trades: z.array(TradeSchema), nextCursor: nullableString, truncated: z.number(), buys: z.number(), sells: z.number(), volumeUsd: z.number() },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const coin = await resolveCoin(ctx, a.address, a.chain, signal);
    if (coin.kind === "external") throw new RefusedError("not_on_platform", "Trades are listed for launchpad coins only. Try get_coin_report for this token's market figures.");
    const page = coin.kind === "sol" ? await ctx.client.sol.tokens.trades(coin.address, a.cursor, { signal }) : await ctx.client.evm.chain(coin.chain).getTrades(coin.address, a.cursor, { signal });
    const trades = page.items.slice(0, a.limit).map(tradeRow);
    const buys = trades.filter((t) => t.side === "buy").length;
    const volumeUsd = trades.reduce((n, t) => n + (t.valueUsd ?? 0), 0);
    return {
      data: { chain: coin.chain, address: coin.address, trades, nextCursor: page.nextCursor, truncated: Math.max(0, page.items.length - a.limit), buys, sells: trades.length - buys, volumeUsd: Number(volumeUsd.toFixed(2)) },
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
    if (coin.kind === "external") throw new RefusedError("not_on_platform", "Holder lists are kept for launchpad coins only.");
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
    if (coin.kind === "external") throw new RefusedError("not_on_platform", "Top traders are kept for launchpad coins only.");
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

export const marketTools = [searchCoins, getBoard, getCoinReport, getCandles, getTrades, getHolders, getTopTraders, getChartEvents];
