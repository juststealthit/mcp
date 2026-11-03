/**
 * Read-only perps market data from Hyperliquid, Aster and Jupiter Perps, grouped by coin. There is no trading here: no orders, no
 * accounts, nothing to sign. Positions are held by each venue, and trading happens on the site from the user's own wallet.
 *
 * @module
 */
import { filterPerpGroups, groupPerpMarkets, type PerpMarket, type PerpVenue } from "@juststealthit/sdk/perps";
import { z } from "zod";

import type { StealthContext } from "../context.js";
import { NotFoundError } from "../errors.js";
import { describeError } from "../errors.js";
import { CandleSchema, nullableNumber } from "../format.js";
import { READ, defineTool } from "./define.js";

const VENUES = ["hyperliquid", "aster", "jupiter"] as const;

async function allMarkets(ctx: StealthContext, venues: PerpVenue[], signal?: AbortSignal) {
  return ctx.memo(`perps:${[...venues].sort().join(",")}`, 20_000, () => ctx.perps.markets({ venues, signal }));
}

const MarketSchema = z.object({
  venue: z.string(),
  symbol: z.string(),
  name: z.string(),
  kind: z.string(),
  assetClass: z.string(),
  price: nullableNumber,
  change24hPct: nullableNumber,
  volume24hUsd: nullableNumber,
  openInterestUsd: nullableNumber,
  maxLeverage: nullableNumber,
  unitMultiplier: z.number(),
});

const marketView = (m: PerpMarket) => ({
  venue: m.venue,
  symbol: m.symbol,
  name: m.name,
  kind: m.kind,
  assetClass: m.assetClass,
  price: m.price,
  change24hPct: m.change24hPct,
  volume24hUsd: m.volume24hUsd,
  openInterestUsd: m.openInterestUsd,
  maxLeverage: m.maxLeverage,
  unitMultiplier: m.unitMultiplier,
});

export const getPerpsMarkets = defineTool({
  name: "get_perps_markets",
  title: "Perps markets",
  description:
    "Read-only perps and spot market data from Hyperliquid, Aster and Jupiter Perps, grouped by coin: price, 24 h change and volume, open interest and the venue's published max leverage. Market data only; this server places no orders. Leverage can lose more than expected.",
  input: {
    query: z.string().trim().max(32).optional().describe("A coin, such as BTC or PEPE"),
    venues: z.array(z.enum(VENUES)).min(1).max(3).optional(),
    kind: z.enum(["perp", "spot"]).optional(),
    assetClass: z.enum(["crypto", "stock", "commodity"]).optional(),
    limit: z.number().int().min(1).max(100).default(20).describe("Coins, busiest first"),
  },
  output: {
    groups: z.array(z.object({ coin: z.string(), kind: z.string(), volume24hUsd: z.number(), maxLeverage: nullableNumber, markets: z.array(MarketSchema) })),
    unavailableVenues: z.array(z.object({ venue: z.string(), reason: z.string() })),
    tradeOnSite: z.string(),
  },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const venues = (a.venues ?? [...VENUES]) as PerpVenue[];
    const { markets, failed } = await allMarkets(ctx, venues, signal);
    const groups = filterPerpGroups(groupPerpMarkets(markets), { kind: a.kind, assetClass: a.assetClass, q: a.query })
      .sort((x, y) => y.volume24hUsd - x.volume24hUsd)
      .slice(0, a.limit)
      .map((g) => ({ coin: g.coin, kind: g.kind, volume24hUsd: g.volume24hUsd, maxLeverage: g.maxLeverage, markets: g.markets.map(marketView) }));
    return {
      data: { groups, unavailableVenues: failed.map((f) => ({ venue: f.venue, reason: describeError(f.error).message })), tradeOnSite: ctx.links.perps() },
      summary: `${groups.length} coin${groups.length === 1 ? "" : "s"} across ${venues.length - failed.length} venue${venues.length - failed.length === 1 ? "" : "s"}.`,
    };
  },
});

export const getPerpsCandles = defineTool({
  name: "get_perps_candles",
  title: "Perps candles",
  description: "Candles for one perps or spot market, oldest first, priced in USD. Jupiter Perps has no candle feed of its own, so its markets read Hyperliquid's candles for the same coin, as the site's chart does.",
  input: {
    venue: z.enum(VENUES),
    coin: z.string().trim().min(1).max(32).describe("The coin (BTC) or the venue's market symbol (BTCUSDT, @107)"),
    interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w"]).default("1h"),
    limit: z.number().int().min(1).max(500).default(120),
  },
  output: { venue: z.string(), market: z.string(), interval: z.string(), candles: z.array(CandleSchema) },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const { markets } = await allMarkets(ctx, [a.venue], signal);
    const q = a.coin.toUpperCase();
    const m = markets.find((x) => x.symbol.toUpperCase() === q && x.kind === "perp") ?? markets.find((x) => x.coin.toUpperCase() === q && x.kind === "perp") ?? markets.find((x) => x.symbol.toUpperCase() === q || x.name.toUpperCase() === q);
    if (!m) throw new NotFoundError(`No ${a.venue} market for ${a.coin}.`);
    const rows = await ctx.perps.candles(m, a.interval, {}, { signal });
    return { data: { venue: m.venue, market: m.name, interval: a.interval, candles: rows.slice(-a.limit) } };
  },
});

export const perpsTools = [getPerpsMarkets, getPerpsCandles];
