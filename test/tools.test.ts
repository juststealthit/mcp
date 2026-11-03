import { afterEach, describe, expect, it } from "vitest";

import { MINT, RISK, call, callError, harness, solToken, type Harness } from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const EVM_TOKEN = "0x8cf19c89ca5ca6fb137ebafdce681bcc48f67eba";

const marketRow = (over: Record<string, unknown> = {}) => {
  const { pool: _p, fees: _f, ...t } = solToken(over);
  return t;
};

describe("market tools", () => {
  it("search_coins strips the $ and summarises each coin", async () => {
    h = await harness({ routes: { "GET /market/tokens/search": [marketRow()] } });
    const r = await call<{ count: number; coins: { symbol: string; url: string; venue: string; launchType: string }[] }>(h, "search_coins", { query: "$TEST" });
    expect(h.calls[0]?.url.searchParams.get("q")).toBe("TEST");
    expect(r.count).toBe(1);
    expect(r.coins[0]).toMatchObject({ symbol: "TEST", venue: "Meteora", launchType: "holders", url: `https://juststealthit.xyz/token/${MINT}` });
  });

  it("get_board maps graduated to the API's stage and keeps the cursor", async () => {
    h = await harness({ routes: { "GET /market/tokens": { items: [marketRow(), marketRow()], nextCursor: "c2", total: 9 } } });
    const r = await call<{ coins: unknown[]; nextCursor: string; truncated: number }>(h, "get_board", { stages: ["graduated", "new"], chains: ["solana", "base"], limit: 1, sort: "volume" });
    const q = h.calls[0]!.url.searchParams;
    expect(q.get("stages")).toBe("migrated,new");
    expect(q.get("chains")).toBe("solana,base");
    expect(q.get("sort")).toBe("volume");
    expect(r).toMatchObject({ nextCursor: "c2", truncated: 1 });
    expect(r.coins).toHaveLength(1);
  });

  it("get_coin_report puts market, launch type, fee routing and banded risk together", async () => {
    h = await harness({
      routes: {
        [`GET /sol/tokens/${MINT}`]: solToken(),
        [`GET /sol/tokens/${MINT}/risk`]: RISK,
        [`GET /sol/tokens/${MINT}/price`]: { priceSol: 0.00000004, priceUsd: 0.000006, marketCapUsd: 6_000, solUsd: 150, at: Date.now(), live: true },
        [`GET /sol/tokens/${MINT}/fee-plan`]: { feeMode: "holders", plan: null },
        [`GET /sol/tokens/${MINT}/rewards`]: {
          feeMode: "holders",
          asset: { mint: null, symbol: "SOL", decimals: 9 },
          pot: { amount: "1", usd: 0.5 },
          totalPaid: { amount: "10", usd: 12 },
          holdersPaid: 30,
          lastRoundAt: Date.now() - 60_000,
          nextRoundAt: Date.now() + 540_000,
          rounds: [],
          rules: { minTokens: 10_000, maxTokens: 40_000_000, everySec: 600 },
        },
      },
    });
    const r = await call<Record<string, any>>(h, "get_coin_report", { address: MINT });
    expect(r.market).toMatchObject({ marketCapUsd: 6_000, livePrice: true, holders: 77 });
    expect(r.launchType).toMatchObject({ id: "holders", label: "Holders" });
    expect(r.feeRouting).toMatchObject({ coinBpsPerTrade: 126, platformBpsPerTrade: 54, venueBpsPerTrade: 45 });
    expect(r.launch).toMatchObject({ venue: "Meteora", taxTier: "m180", pair: "SOL", antiSniper: { applies: true, open: false, currentFeeBps: 225 } });
    const levels = Object.fromEntries(r.risk.flags.map((f: { line: string; level: string }) => [f.line, f.level]));
    expect(levels["Top 10 holders, % of supply"]).toBe("amber");
    expect(levels["Launcher + creator hold, % of supply"]).toBe("red");
    expect(levels["Launcher or creator sold"]).toBe("amber");
    expect(levels["Snipers still hold, % of supply"]).toBe("green");
    expect(r.extras.holderRewards).toMatchObject({ holdersPaid: 30, totalPaidUsd: 12 });
  });

  it("get_coin_report reads a Solana token the launchpad doesn't know through the wider market", async () => {
    h = await harness({
      routes: {
        [`GET /sol/market/coins/${MINT}`]: {
          address: MINT,
          symbol: "EXT",
          name: "External",
          logo: null,
          priceUsd: 1,
          marketCapUsd: 1e6,
          athMarketCapUsd: null,
          liquidityUsd: 1e5,
          volumeUsd: 5e4,
          changePct: 2,
          holders: 900,
          swaps: 10,
          createdAt: null,
          launchpad: "elsewhere",
          creator: null,
          twitter: null,
          website: null,
          telegram: null,
          smartWallets: null,
          kolWallets: null,
          top10Pct: 61,
          onCurve: false,
          onPlatform: false,
          decimals: 6,
          totalSupply: 1e9,
          description: null,
          discord: null,
          volume24hUsd: 5e4,
          buys24h: 1,
          sells24h: 2,
          change1hPct: 0,
          change24hPct: 2,
          curveProgress: null,
          creatorHoldPct: 1,
          sniperWallets: 0,
          bundlerWallets: 0,
          launcher: null,
          feeSharing: null,
          estCreatorFees24hUsd: null,
          estSharedFees24hUsd: null,
        },
      },
    });
    const r = await call<Record<string, any>>(h, "get_coin_report", { address: MINT });
    expect(r.onPlatform).toBe(false);
    expect(r.stage).toBe("external");
    expect(r.warnings[0]).toMatch(/wasn't launched on Just Stealth It/);
    expect(r.risk.flags[0]).toMatchObject({ value: 61, level: "red" });
  });

  it("get_coin_report finds an EVM coin on every chain it exists on, and says so", async () => {
    const evm = (chain: string) => ({ ...marketRow({ address: EVM_TOKEN, taxBps: 125, volume24hUsd: chain === "base" ? 900 : 10 }), sol: undefined, feeMode: "creator", evm: { chain, chainId: 1, native: "ETH", launchType: "creator", rules: 0, dex: "v4", feeVault: "0x", settlement: "0x" } });
    h = await harness({
      routes: {
        [`GET /evm/chains/base/tokens/${EVM_TOKEN}`]: { ...evm("base"), feePlan: null, pool: {}, fees: { creator: { unclaimedEth: 0, claimedEth: 0, recipient: "0x1", pendingRecipient: null } } },
        [`GET /evm/chains/robinhood/tokens/${EVM_TOKEN}`]: { ...evm("robinhood"), feePlan: null, pool: {}, fees: { creator: { unclaimedEth: 0, claimedEth: 0, recipient: "0x1", pendingRecipient: null } } },
      },
    });
    const r = await call<Record<string, any>>(h, "get_coin_report", { address: EVM_TOKEN });
    expect(r.chain).toBe("base");
    expect(r.feeRouting).toMatchObject({ coinBpsPerTrade: 87.5, platformBpsPerTrade: 37.5 });
    expect(r.warnings.some((w: string) => /also a separate coin on/.test(w))).toBe(true);
  });

  it("reports an unknown coin as a not_found tool error, and a bad address as invalid input", async () => {
    h = await harness();
    const e = await callError(h, "get_coin_report", { address: MINT });
    expect(e.error?.code).toBe("not_found");
    const bad = await callError(h, "get_coin_report", { address: "not-an-address-at-all-not-an-address" });
    expect(bad.text).toMatch(/Invalid arguments|address/);
  });

  it("get_candles and get_trades shape rows and honour limit", async () => {
    const candle = (t: number) => ({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, volumeEth: 0.1 });
    const trade = (i: number, side: string) => ({ id: `t${i}`, token: MINT, txHash: `h${i}`, blockNumber: 1, logIndex: 0, kind: "trade", trader: "w", side, ethAmount: 0.1, tokenAmount: 100, priceEth: 0.001, priceUsd: 0.1, valueUsd: 15, feeEth: 0, feePips: 0, sqrtPriceX96: "0", sniperTaxed: false, isCreatorLaunchBuy: false, timestamp: Date.now() });
    h = await harness({
      routes: {
        [`GET /sol/tokens/${MINT}`]: solToken(),
        [`GET /sol/tokens/${MINT}/candles`]: [candle(1), candle(2), candle(3)],
        [`GET /sol/tokens/${MINT}/trades`]: { items: [trade(1, "buy"), trade(2, "sell"), trade(3, "buy")], nextCursor: null, total: 3 },
      },
    });
    const c = await call<{ candles: { time: number }[]; priceUnit: string }>(h, "get_candles", { address: MINT, interval: "1m", limit: 2 });
    expect(c.candles.map((x) => x.time)).toEqual([2, 3]);
    expect(c.priceUnit).toBe("SOL");
    const t = await call<{ trades: unknown[]; buys: number; sells: number; volumeUsd: number }>(h, "get_trades", { address: MINT });
    expect(t).toMatchObject({ buys: 2, sells: 1, volumeUsd: 45 });
  });
});

describe("platform tools", () => {
  it("get_stealth_burns combines supply, schedule, burns and contributors", async () => {
    h = await harness({
      routes: {
        "GET /sol/burn": {
          mint: "M",
          symbol: "STEALTH",
          onchainSymbol: "STEALTH",
          decimals: 6,
          initialSupply: 1e9,
          currentSupply: 9.5e8,
          burned: 5e7,
          burnedPct: 5,
          raw: {},
          supplySource: "rpc",
          wallets: [],
          split: { marketingPctOfCoinFee: 0 },
          totals: { feesSol: 1, feesUsd: 150, fees24hSol: 0.1, fees7dSol: 0.5, sentSol: 1, accruingSol: 0, coins: 3, burnsCount: 4, burnedByWallets: 0, buybacksCount: 4, boughtBack: 5e7, solSpent: 2 },
          solUsd: 150,
          recentBurns: [],
          syncedAt: 1,
          updatedAt: 1,
          status: "live",
        },
        "GET /sol/burn/next": { everyHours: 6, lastAt: 1, nextAt: 2, progress: 0.5, now: 1 },
        "GET /sol/burn/events": { items: [{ sig: "s1", seq: 0, slot: 1, time: 1_700_000_000_000, amount: 1000, amountRaw: "1", wallet: "w", authority: "a", solSpent: 0.1, solscan: "https://solscan.io/tx/s1" }], nextCursor: null, updatedAt: 1 },
        "GET /sol/burn/coins": { range: "24h", items: [{ mint: MINT, symbol: "TEST", name: "T", logoUrl: null, status: "new", feesSol: 0.2, feesUsd: 30, sharePct: 50, fees24hSol: 0.2, allTimeFeesSol: 1, sentSol: 0, accruingSol: 0, rank: 1 }], count: 1, totalFeesSol: 0.4, totalFeesUsd: 60, updatedAt: 1 },
      },
    });
    const r = await call<Record<string, any>>(h, "get_stealth_burns", { recent: 1, topCoins: 1 });
    expect(r.supply).toMatchObject({ burnedPct: 5, current: 9.5e8 });
    expect(r.nextBurn).toMatchObject({ everyHours: 6, progress: 0.5 });
    expect(r.recentBurns[0]).toMatchObject({ tx: "s1", amount: 1000 });
    expect(r.topCoins[0]).toMatchObject({ symbol: "TEST", sharePct: 50 });
  });

  it("get_platform_status leaves out resolved incidents and needs no single source to be up", async () => {
    h = await harness({
      routes: {
        "GET /status/summary": {
          overall: "degraded",
          network: "mainnet",
          checkedAt: 1,
          sampleEveryMin: 5,
          components: [{ key: "api", state: "operational", latencyMs: 10, lagSec: null, incident: false, uptimePct: 99.9, days: [] }],
          incidents: [
            { id: 1, title: "Old", severity: "minor", component: "api", status: "resolved", body: "", startedAt: 1, resolvedAt: 2, updatedAt: 2 },
            { id: 2, title: "Indexer lag", severity: "major", component: "indexer", status: "monitoring", body: "", startedAt: 3, resolvedAt: null, updatedAt: 3 },
          ],
          metrics: null,
        },
      },
    });
    const r = await call<Record<string, any>>(h, "get_platform_status");
    expect(r.overall).toBe("degraded");
    expect(r.incidents).toEqual([expect.objectContaining({ title: "Indexer lag" })]);
    expect(r.solana).toBeNull();
    expect(r.statusPage).toBe("https://juststealthit.xyz/status");
  });

  it("list_chains marks coming-soon chains", async () => {
    h = await harness();
    const r = await call<{ chains: { key: string; status: string }[] }>(h, "list_chains");
    expect(r.chains.find((c) => c.key === "arbitrum")?.status).toBe("coming_soon");
    expect(r.chains.find((c) => c.key === "solana")?.status).toBe("live");
  });

  it("get_perps_markets groups venues and reports a venue that failed", async () => {
    h = await harness({
      routes: {
        "GET https://perps-api.jup.ag/v1/market-stats": (c: { url: URL }) => ({ price: "100", priceChange24H: "1.5", volume: String(c.url.searchParams.get("mint")!.length * 1000) }),
      },
    });
    const r = await call<{ groups: { coin: string; markets: Record<string, unknown>[] }[]; unavailableVenues: { venue: string }[] }>(h, "get_perps_markets", { venues: ["jupiter", "aster"], limit: 5 });
    expect(r.groups.map((g) => g.coin).sort()).toEqual(["BTC", "ETH", "SOL"]);
    expect(r.unavailableVenues.map((v) => v.venue)).toEqual(["aster"]);
    // read-only market data: nothing about funding or fees is passed on
    expect(JSON.stringify(r)).not.toMatch(/funding|fee/i);
  });
});

describe("maths tools", () => {
  it("calc_sniper_fee follows the documented line", async () => {
    h = await harness();
    const r = await call<{ feeBps: number; windowOpen: boolean; schedule: { second: number; feePct: number }[] }>(h, "calc_sniper_fee", { tierBps: 125, secondsSinceLaunch: 14 });
    expect(r.feeBps).toBeCloseTo(716.67, 2);
    expect(r.windowOpen).toBe(true);
    expect(r.schedule[0]).toEqual({ second: 0, feePct: 90 });
    expect(r.schedule[15]).toEqual({ second: 15, feePct: 1.25 });
  });

  it("calc_fee_split matches the docs' tables", async () => {
    h = await harness();
    const ray = await call<{ perTradeBps: Record<string, number>; amounts: Record<string, string> }>(h, "calc_fee_split", { venue: "raydium", tierBps: 575, amount: "10" });
    expect(ray.perTradeBps).toEqual({ coin: 50, platform: 500, venue: 25, total: 575 });
    expect(ray.amounts).toEqual({ total: "0.575", coin: "0.05", platform: "0.5", venue: "0.025" });
    const evm = await call<{ perTradeBps: Record<string, number> }>(h, "calc_fee_split", { venue: "evm", tierBps: 575 });
    expect(evm.perTradeBps).toMatchObject({ coin: 402.5, platform: 172.5 });
    await expect(callError(h, "calc_fee_split", { venue: "meteora", tierBps: 300 })).resolves.toMatchObject({ error: { code: "invalid_input" } });
  });

  it("calc_curve_quote previews a fresh curve", async () => {
    h = await harness();
    const r = await call<{ amountOut: string; progressAfter: number; priceImpactPct: number }>(h, "calc_curve_quote", {
      side: "buy",
      amount: "1000000000",
      feeBps: 125,
      init: { supply: "1000000000000000", totalSell: "793100000000000", raise: "85000000000" },
    });
    expect(BigInt(r.amountOut)).toBeGreaterThan(0n);
    expect(r.progressAfter).toBeGreaterThan(0);
    expect(r.priceImpactPct).toBeGreaterThan(0);
  });

  it("calc_staking_estimate works offline from a given rate", async () => {
    h = await harness();
    const r = await call<{ estimatedReward: string; source: string; note: string }>(h, "calc_staking_estimate", { amount: "1000", days: 365, aprBps: 1_000, decimals: 6 });
    expect(r.source).toBe("input");
    expect(Number(r.estimatedReward)).toBeCloseTo(100, 3);
    expect(r.note).toMatch(/Not a promise/);
  });

  it("quote_trade converts whole units both ways", async () => {
    h = await harness({
      routes: {
        [`GET /sol/tokens/${MINT}`]: solToken(),
        "GET /sol/quote": { venue: "curve", side: "buy", amountIn: "500000000", amountOut: "1234567890", minAmountOut: "1197530853", feeLamports: "1", feeBps: 225, priceImpactPct: 0.4 },
      },
    });
    const r = await call<Record<string, any>>(h, "quote_trade", { address: MINT, side: "buy", amount: "0.5" });
    expect(h.calls.find((c) => c.path.startsWith("/sol/quote"))?.url.searchParams.get("amount")).toBe("500000000");
    expect(r.amountOut).toEqual({ raw: "1234567890", amount: "1234.56789", unit: "TEST" });
    expect(r.route).toBe("bonding curve");
  });
});

describe("staking tools", () => {
  it("says plainly when staking isn't open", async () => {
    h = await harness({ routes: { "GET /staking": { enabled: false, pools: [] } } });
    expect(await call(h, "get_staking_pools")).toMatchObject({ enabled: false, pools: [] });
    const e = await callError(h, "get_staking_position", { owner: MINT });
    expect(e.error?.code).toBe("staking_closed");
  });
});
