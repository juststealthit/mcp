/**
 * Platform reads: the $STEALTH buy back and burn, the Feed and its fee board, status, totals, launch options and the chain registry.
 *
 * @module
 */
import { isFeedEvent, type FeedItem } from "@juststealthit/sdk/api";
import { TAX_TIERS_BPS } from "@juststealthit/sdk/math";
import { comingSoonChains, listChains } from "@juststealthit/sdk/utils";
import { z } from "zod";

import { iso, launchTypeLabel, nullableNumber, nullableString, num, str } from "../format.js";
import { EVM_TYPES } from "./actions.js";
import { READ, defineTool } from "./define.js";

const ComingSoonSchema = z.object({ key: z.string(), name: z.string(), deploying: z.boolean() });
/** Announced chains with nothing to use yet, from the SDK's registry. */
const comingSoon = () => comingSoonChains().map((c) => ({ key: c.key, name: c.name, deploying: c.deploying }));

export const getStealthBurns = defineTool({
  name: "get_stealth_burns",
  title: "$STEALTH burns",
  description:
    "The $STEALTH buy back and burn: supply and how much is burned, fees that fund it, the buy-backs and burns so far with their transactions, when the next one runs, the buy-back bot's state, and the coins whose fees feed it the most. Buy-backs are paid for by the coin's own fees. A burn reduces supply; it isn't a promise of any price or value.",
  input: {
    range: z.enum(["24h", "7d", "all"]).default("24h").describe("Window for the contributing coins"),
    recent: z.number().int().min(0).max(50).default(10).describe("How many recent burns to list"),
    topCoins: z.number().int().min(0).max(25).default(5),
  },
  output: {
    token: z.object({ mint: nullableString, symbol: nullableString, decimals: z.number() }),
    status: z.string(),
    supply: z.object({ initial: nullableNumber, current: nullableNumber, burned: nullableNumber, burnedPct: nullableNumber }),
    totals: z.looseObject({}),
    nextBurn: z.object({ everyHours: nullableNumber, lastAt: nullableString, nextAt: nullableString, progress: nullableNumber }).nullable(),
    recentBurns: z.array(z.object({ time: nullableString, amount: nullableNumber, solSpent: nullableNumber, tx: z.string(), explorer: nullableString })),
    topCoins: z.array(z.object({ mint: z.string(), symbol: z.string(), feesSol: nullableNumber, sharePct: nullableNumber, url: z.string() })),
    buybackBot: z
      .object({
        status: z.string().describe("live, paused, low_balance or not_configured"),
        mode: z.string().describe("buy_burn burns what it buys; buy keeps it; buy_send sets it aside"),
        everyMinutes: nullableNumber,
        lastRunAt: nullableString,
        nextAt: nullableString,
        nextBuySol: nullableNumber,
        totals: z.object({ buys: z.number(), solSpent: z.number(), tokensBurned: z.number() }),
      })
      .nullable()
      .describe("The bot that runs the $STEALTH buy-backs, paid for by the coin's own fees"),
    updatedAt: nullableString,
  },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const [o, next, events, coins, bot] = await Promise.all([
      ctx.client.sol.burn.overview({ signal }),
      ctx.client.sol.burn.next({ signal }).catch(() => null),
      a.recent > 0 ? ctx.client.sol.burn.events({ limit: a.recent }, { signal }).catch(() => null) : Promise.resolve(null),
      a.topCoins > 0 ? ctx.client.sol.burn.coins({ range: a.range, limit: a.topCoins }, { signal }).catch(() => null) : Promise.resolve(null),
      ctx.client.sol.burn.bot({ signal }).catch(() => null),
    ]);
    const burns = events?.items ?? o.recentBurns.map((b) => ({ ...b, solscan: b.solscan }));
    const recentBurns = burns.slice(0, a.recent).map((b) => ({ time: iso(b.time), amount: num(b.amount), solSpent: num(b.solSpent), tx: b.sig, explorer: str(b.solscan) }));
    const data = {
      token: { mint: o.mint, symbol: o.symbol, decimals: o.decimals },
      status: o.status,
      supply: { initial: num(o.initialSupply), current: num(o.currentSupply), burned: num(o.burned), burnedPct: num(o.burnedPct) },
      totals: { ...o.totals, solUsd: num(o.solUsd) },
      nextBurn: next ? { everyHours: num(next.everyHours), lastAt: iso(next.lastAt), nextAt: iso(next.nextAt), progress: num(next.progress) } : null,
      recentBurns,
      topCoins: (coins?.items ?? []).map((c) => ({ mint: c.mint, symbol: c.symbol, feesSol: num(c.feesSol), sharePct: num(c.sharePct), url: ctx.links.coin(c.mint) })),
      buybackBot: bot
        ? {
            status: String(bot.status),
            mode: String(bot.mode),
            everyMinutes: num(bot.everyMin),
            lastRunAt: iso(bot.lastRunAt),
            nextAt: iso(bot.nextAt),
            nextBuySol: num(bot.nextBuySol),
            totals: { buys: num(bot.totals?.buys) ?? 0, solSpent: num(bot.totals?.solSpent) ?? 0, tokensBurned: num(bot.totals?.tokensBurned) ?? 0 },
          }
        : null,
      updatedAt: iso(o.updatedAt),
    };
    const pct = data.supply.burnedPct;
    return { data, summary: `${o.symbol ?? "$STEALTH"}: ${pct === null ? "burned share unknown" : `${pct.toFixed(3)}% of supply burned`}, ${o.totals.burnsCount} burns and ${o.totals.buybacksCount} buy-backs so far.` };
  },
});

export function feedItem(item: FeedItem) {
  if (isFeedEvent(item)) {
    const e = item.event;
    return {
      id: item.id,
      at: iso(item.at),
      type: "event" as const,
      kind: e.kind,
      chain: e.chain,
      coin: e.token ? { address: e.token, symbol: str(e.symbol), name: str(e.name) } : null,
      usd: num(e.usd),
      native: num(e.native),
      nativeSymbol: str(e.nativeSymbol),
      text: null,
      author: str(item.author?.profile?.displayName) ?? str(item.author?.address),
      link: str(e.txUrl) ?? str(e.proofUrl),
    };
  }
  return { id: item.id, at: iso(item.at), type: "post" as const, kind: "post", chain: null, coin: null, usd: null, native: null, nativeSymbol: null, text: item.text, author: str(item.author.displayName), link: null };
}

export const getFeed = defineTool({
  name: "get_feed",
  title: "The Feed",
  description:
    "The Feed, newest first: launches, graduations, finished marketing steps, burns, dev buys and claims across every chain, plus people's posts. Posts are their authors' views; platform posts are automated. None of it is advice.",
  input: {
    filter: z.enum(["all", "coins", "posts", "socials"]).default("all"),
    limit: z.number().int().min(1).max(50).default(20),
    before: z.string().max(256).optional().describe("`next` from the previous page"),
  },
  output: {
    items: z.array(
      z.object({
        id: z.string(),
        at: nullableString,
        type: z.enum(["event", "post"]),
        kind: z.string(),
        chain: nullableString,
        coin: z.object({ address: z.string(), symbol: nullableString, name: nullableString }).nullable(),
        usd: nullableNumber,
        native: nullableNumber,
        nativeSymbol: nullableString,
        text: nullableString,
        author: nullableString,
        link: nullableString,
      }),
    ),
    next: nullableString,
  },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const page = await ctx.client.feed.list({ filter: a.filter, limit: a.limit, before: a.before }, { signal });
    return { data: { items: page.items.map(feedItem), next: page.next } };
  },
});

export const getFeeBoard = defineTool({
  name: "get_fee_board",
  title: "Fee board",
  description:
    "Creator fees paid out across every chain over 7 or 30 days, by launch type (creator, social, holders, buy back, marketing, liquidity), with the chains and coins that paid the most. Also the platform dev wallet's buys and the $STEALTH burns at a glance.",
  input: { days: z.union([z.literal(7), z.literal(30)]).default(30), topCoins: z.number().int().min(0).max(10).default(3) },
  output: {
    days: z.number(),
    totalUsd: nullableNumber,
    types: z.array(
      z.object({
        type: z.string(),
        label: nullableString,
        usd: nullableNumber,
        payouts: nullableNumber,
        chains: z.array(z.object({ chain: z.string(), usd: nullableNumber })),
        topCoins: z.array(z.object({ address: z.string(), chain: z.string(), symbol: z.string(), usd: nullableNumber })),
      }),
    ),
    overview: z.looseObject({}).nullable(),
    updatedAt: nullableString,
  },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const [board, overview] = await Promise.all([ctx.client.feed.fees(a.days, { signal }), ctx.client.feed.feesOverview({ signal }).catch(() => null)]);
    const types = board.types.map((t) => ({
      type: t.type,
      label: launchTypeLabel(t.type === "liquidity" ? "liquidity" : t.type),
      usd: num(t.usd),
      payouts: num(t.payouts),
      chains: t.chains.map((c) => ({ chain: c.chain, usd: num(c.usd) })),
      topCoins: t.coins.slice(0, a.topCoins).map((c) => ({ address: c.address, chain: c.chain, symbol: c.symbol, usd: num(c.usd) })),
    }));
    const ov = overview
      ? {
          creatorFeesUsd: num(overview.creatorFees?.usd),
          devBuys: overview.devBuys ? { count: overview.devBuys.count, sol: num(overview.devBuys.sol), usd: num(overview.devBuys.usd), wallet: overview.devBuys.wallet } : null,
          burns: overview.burns ? { count: overview.burns.count, tokens: num(overview.burns.tokens), pctOfSupply: num(overview.burns.pctOfSupply), usd: num(overview.burns.usd) } : null,
        }
      : null;
    return { data: { days: board.days, totalUsd: num(board.totalUsd), types, overview: ov, updatedAt: iso(board.updatedAt) }, summary: `$${(board.totalUsd ?? 0).toFixed(0)} of creator fees paid out in ${board.days} days.` };
  },
});

export const getPlatformStatus = defineTool({
  name: "get_platform_status",
  title: "Platform status",
  description: "Whether the site is open, every system's state and uptime, open incidents, which EVM chains are switched on and which are coming soon, and how far the Solana indexer is behind the chain.",
  input: {},
  output: {
    site: z.object({ comingSoon: z.boolean(), comingSoonUntil: nullableString, tagline: nullableString, officialCoin: nullableString }),
    overall: nullableString,
    components: z.array(z.object({ key: z.string(), state: z.string(), uptimePct: nullableNumber, lagSec: nullableNumber })),
    incidents: z.array(z.object({ title: z.string(), severity: z.string(), component: z.string(), status: z.string(), startedAt: nullableString })),
    solana: z.object({ network: nullableString, solUsd: nullableNumber, indexerLagSlots: nullableNumber, features: z.record(z.string(), z.string()) }).nullable(),
    evmChains: z.array(z.object({ id: z.string(), chainId: z.number(), name: z.string(), native: z.string(), dex: z.string() })),
    comingSoonChains: z.array(ComingSoonSchema),
    statusPage: z.string(),
  },
  annotations: READ,
  async run(_a, { ctx, signal }) {
    const [app, summary, sol, evm] = await Promise.all([
      ctx.client.platform.appConfig({ signal }).catch(() => null),
      ctx.client.platform.statusSummary({ signal }).catch(() => null),
      ctx.client.sol.status({ signal }).catch(() => null),
      ctx.client.evm.config(undefined, { signal }).catch(() => null),
    ]);
    const data = {
      site: { comingSoon: app?.comingSoon === true, comingSoonUntil: str(app?.comingSoonUntil), tagline: str(app?.tagline), officialCoin: str(app?.officialCa) },
      overall: str(summary?.overall),
      components: (summary?.components ?? []).map((c) => ({ key: c.key, state: c.state, uptimePct: num(c.uptimePct), lagSec: num(c.lagSec) })),
      incidents: (summary?.incidents ?? []).filter((i) => i.status !== "resolved").map((i) => ({ title: i.title, severity: i.severity, component: i.component, status: i.status, startedAt: iso(i.startedAt) })),
      solana: sol
        ? {
            network: str(sol.network),
            solUsd: num(sol.solUsd?.usd),
            indexerLagSlots: num(sol.indexer?.lag),
            features: Object.fromEntries(Object.entries(sol.features ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>,
          }
        : null,
      evmChains: evm?.enabled ? evm.chains.map((c) => ({ id: c.id, chainId: c.chainId, name: c.name, native: c.native, dex: c.dex === "infinity" ? "PancakeSwap Infinity" : "Uniswap v4" })) : [],
      comingSoonChains: comingSoon(),
      statusPage: ctx.links.status(),
    };
    return { data, summary: `Overall: ${data.overall ?? "unknown"}. ${data.incidents.length} open incident${data.incidents.length === 1 ? "" : "s"}.${data.site.comingSoon ? " The site shows Coming soon." : ""}` };
  },
});

export const getPlatformStats = defineTool({
  name: "get_platform_stats",
  title: "Platform totals",
  description: "Platform-wide totals across chains: coins launched and live, graduations, 24 h volume, holder rewards and marketing raised, the launch-type and pair mix, and launches and volume per day.",
  input: { chain: z.enum(["all", "solana"]).default("all") },
  output: {
    coins: nullableNumber,
    coinsLive: nullableNumber,
    graduated: nullableNumber,
    volume24hUsd: nullableNumber,
    holderRewardsPaidUsd: nullableNumber,
    holderRounds: nullableNumber,
    marketingRaisedUsd: nullableNumber,
    tiersBought: nullableNumber,
    launchTypes: z.array(z.object({ id: z.string(), label: nullableString, count: z.number() })),
    pairMix: z.array(z.object({ kind: z.string(), count: z.number() })),
    launchesLast7d: z.array(z.object({ day: z.string(), count: z.number() })),
    volumeLast7d: z.array(z.object({ day: z.string(), usd: z.number() })),
    updatedAt: nullableString,
  },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const s = a.chain === "solana" ? await ctx.client.sol.stats({ signal }) : await ctx.client.market.stats({ signal });
    return {
      data: {
        coins: num(s.coins),
        coinsLive: num(s.coinsLive),
        graduated: num(s.graduated),
        volume24hUsd: num(s.volume24hUsd),
        holderRewardsPaidUsd: num(s.holderRewardsPaidUsd),
        holderRounds: num(s.holderRounds),
        marketingRaisedUsd: num(s.marketingRaisedUsd),
        tiersBought: num(s.tiersBought),
        launchTypes: (s.feeModes ?? []).map((m) => ({ id: m.mode, label: launchTypeLabel(m.mode), count: m.count })),
        pairMix: s.pairMix ?? [],
        launchesLast7d: (s.launches30d ?? []).slice(-7),
        volumeLast7d: (s.volume30d ?? []).slice(-7),
        updatedAt: iso(s.updatedAt),
      },
    };
  },
});

export const getLaunchOptions = defineTool({
  name: "get_launch_options",
  title: "Launch options",
  description:
    "What a launch can pick right now, as the server has it: Solana venues with their tax tiers and who gets what of each, the launch types on offer, whether launches are paused, and the EVM chains that are open. Call this before prepare_launch.",
  input: {},
  output: {
    solana: z
      .object({
        launchesPaused: z.boolean(),
        venues: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            enabled: z.boolean(),
            default: z.boolean(),
            antiSniper: z.boolean(),
            taxTiers: z.array(z.object({ id: z.string(), totalBps: z.number(), coinBps: z.number(), platformBps: z.number(), venueBps: z.number(), default: z.boolean() })),
          }),
        ),
        launchTypes: z.array(z.object({ id: z.string(), label: nullableString, available: z.boolean(), default: z.boolean() })),
      })
      .nullable(),
    evm: z
      .object({
        enabled: z.boolean(),
        chains: z.array(z.object({ id: z.string(), chainId: z.number(), name: z.string(), native: z.string() })),
        launchTypes: z.array(z.string()),
        taxTiersBps: z.array(z.number()),
        comingSoon: z.array(ComingSoonSchema).describe("Announced chains that take no launches yet"),
      })
      .nullable(),
  },
  annotations: READ,
  async run(_a, { ctx, signal }) {
    const [sol, evm] = await Promise.all([ctx.client.sol.config({ signal }).catch(() => null), ctx.client.evm.config(undefined, { signal }).catch(() => null)]);
    return {
      data: {
        solana: sol
          ? {
              launchesPaused: sol.launchesPaused === true,
              venues: sol.venues.map((v) => ({
                id: v.id,
                label: v.label,
                enabled: v.enabled,
                default: v.default,
                antiSniper: !!v.sniperFee,
                taxTiers: v.taxTiers.map((t) => ({ id: t.id, totalBps: t.totalBps, coinBps: t.creatorBps, platformBps: t.platformBps, venueBps: t.protocolBps, default: t.default })),
              })),
              launchTypes: sol.feeModes.map((m) => ({ id: m.id, label: launchTypeLabel(m.id), available: m.available, default: m.default })),
            }
          : null,
        evm: evm
          ? {
              enabled: evm.enabled,
              chains: evm.chains.map((c) => ({ id: c.id, chainId: c.chainId, name: c.name, native: c.native })),
              launchTypes: [...EVM_TYPES],
              taxTiersBps: [...TAX_TIERS_BPS],
              comingSoon: comingSoon(),
            }
          : null,
      },
    };
  },
});

export const listChainsTool = defineTool({
  name: "list_chains",
  title: "Chains",
  description:
    "Every chain the platform runs on or has announced, with its gas coin, DEX and explorer. Live chains take launches and trades. Coming-soon chains (Ethereum, Arbitrum One and Avalanche C-Chain, whose contracts are being deployed, and X Layer) have no addresses yet and can't be used: tools refuse them.",
  input: {},
  output: {
    chains: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        family: z.string().describe("svm (Solana) or evm"),
        status: z.enum(["live", "coming_soon"]),
        deploying: z.boolean().describe("A coming-soon chain whose contracts are being deployed now. Its addresses are published once checked"),
        chainId: nullableNumber,
        native: nullableString,
        dex: nullableString,
        explorer: nullableString,
      }),
    ),
  },
  annotations: { ...READ, openWorldHint: false },
  async run() {
    const chains = listChains().map((c) => ({ key: c.key, name: c.name, family: c.family, status: c.status, deploying: c.deploying, chainId: c.chainId, native: c.native, dex: c.dex, explorer: c.explorer }));
    const soon = chains.filter((c) => c.status === "coming_soon").map((c) => c.name);
    return { data: { chains }, summary: `${chains.length - soon.length} live chains. Coming soon: ${soon.join(", ")}.` };
  },
});

export const platformTools = [getStealthBurns, getFeed, getFeeBoard, getPlatformStatus, getPlatformStats, getLaunchOptions, listChainsTool];
