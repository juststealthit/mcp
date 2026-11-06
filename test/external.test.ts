/**
 * The platform's newer reach: external coins from every live chain, coming-soon chains, and candles that start at 1 minute.
 */
import { afterEach, describe, expect, it } from "vitest";

import { MINT, call, callError, harness, solToken, type Harness } from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const BNB_COIN = "0x55d398326f99059ff775485246999027b3197955";

/** A coin page as the market route answers for a coin that didn't launch here. */
export const marketCoin = (over: Record<string, unknown> = {}) => ({
  address: BNB_COIN,
  symbol: "FOUR",
  name: "Four",
  logo: null,
  priceUsd: 0.01,
  marketCapUsd: 2e6,
  athMarketCapUsd: null,
  liquidityUsd: 3e5,
  volumeUsd: 9e5,
  changePct: 12,
  holders: 4_000,
  swaps: 100,
  createdAt: Date.now() - 86_400_000,
  launchpad: "fourmeme",
  creator: null,
  twitter: null,
  website: null,
  telegram: null,
  smartWallets: null,
  kolWallets: null,
  top10Pct: 22,
  onCurve: false,
  onPlatform: false,
  decimals: 18,
  totalSupply: 1e9,
  description: null,
  discord: null,
  volume24hUsd: 9e5,
  buys24h: 10,
  sells24h: 8,
  change1hPct: 1,
  change24hPct: 12,
  curveProgress: null,
  creatorHoldPct: 0,
  sniperWallets: 0,
  bundlerWallets: 0,
  launcher: null,
  feeSharing: null,
  estCreatorFees24hUsd: null,
  estSharedFees24hUsd: null,
  ...over,
});

describe("external coins on EVM chains", () => {
  it("get_coin_report finds a coin trending on BNB Chain that didn't launch here, and links its trending page", async () => {
    h = await harness({ routes: { [`GET /sol/market/coins/${BNB_COIN}`]: (c: { url: URL }) => (c.url.searchParams.get("chain") === "bnb" ? marketCoin() : { __reply: true, status: 404, body: { error: "not_found" } }) } });
    const r = await call<Record<string, any>>(h, "get_coin_report", { address: BNB_COIN });
    expect(r).toMatchObject({ chain: "bnb", onPlatform: false, stage: "external", symbol: "FOUR" });
    expect(r.market.nativeSymbol).toBe("BNB");
    expect(r.links.page).toBe(`https://juststealthit.xyz/trending/${BNB_COIN}?chain=bnb`);
    expect(r.warnings.join(" ")).toMatch(/Relay/);
    expect(r.feeRouting.note).toMatch(/no trading fee/);
  });

  it("refuses to build a trade for one, and says where it trades", async () => {
    h = await harness({ routes: { [`GET /sol/market/coins/${BNB_COIN}`]: marketCoin() } });
    const e = await callError(h, "prepare_buy", { address: BNB_COIN, chain: "bnb", amount: "0.1", wallet: "0x0000000000000000000000000000000000000001" });
    expect(e.error?.code).toBe("trade_on_site");
    expect(e.text).toMatch(/trending\/0x55d3.*chain=bnb/);
    expect((await callError(h, "quote_trade", { address: BNB_COIN, chain: "bnb", side: "buy", amount: "0.1" })).error?.code).toBe("trade_on_site");
    expect((await callError(h, "get_holders", { address: BNB_COIN, chain: "bnb" })).error?.code).toBe("not_on_platform");
  });

  it("get_candles reads its USD candles with the chain, and pages back with `to`", async () => {
    const candle = (t: number) => ({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volumeUsd: 100 });
    h = await harness({ routes: { [`GET /sol/market/coins/${BNB_COIN}`]: marketCoin(), [`GET /sol/market/coins/${BNB_COIN}/candles`]: [candle(100), candle(160)] } });
    const r = await call<Record<string, any>>(h, "get_candles", { address: BNB_COIN, chain: "bnb", interval: "1D", to: 1_000 });
    const q = h.calls.find((c) => c.path.includes("/candles"))!.url.searchParams;
    expect(q.get("chain")).toBe("bnb");
    expect(q.get("interval")).toBe("1d");
    expect(q.get("to")).toBe("1000");
    expect(r).toMatchObject({ chain: "bnb", priceUnit: "USD", count: 2 });
  });
});

describe("Solana tokens that didn't launch here", () => {
  it("link their trending page, since the token page is only for coins launched here", async () => {
    h = await harness({ routes: { [`GET /sol/market/coins/${MINT}`]: marketCoin({ address: MINT, decimals: 6 }) } });
    const r = await call<Record<string, any>>(h, "get_coin_report", { address: MINT });
    expect(r.links.page).toBe(`https://juststealthit.xyz/trending/${MINT}`);
  });
});

describe("chains", () => {
  it("lists the coming-soon chains with no addresses, and refuses them as inputs", async () => {
    h = await harness();
    const r = await call<{ chains: { key: string; status: string; deploying: boolean; dex: string | null }[] }>(h, "list_chains");
    const byKey = Object.fromEntries(r.chains.map((c) => [c.key, c]));
    for (const k of ["ethereum", "arbitrum", "avalanche"]) expect(byKey[k]).toMatchObject({ status: "coming_soon", deploying: true, dex: null });
    expect(byKey.xlayer).toMatchObject({ status: "coming_soon", deploying: false });
    expect(byKey.base).toMatchObject({ status: "live" });
    const e = await callError(h, "get_coin_report", { address: BNB_COIN, chain: "arbitrum" });
    expect(e.error?.code).toBe("unsupported");
    expect(e.text).toMatch(/coming soon/);
    expect((await callError(h, "search_coins", { query: "x", chains: ["solana", "avalanche"] })).error?.code).toBe("unsupported");
  });

  it("marks external rows on the All board for what they are", async () => {
    const { pool: _p, fees: _f, sol: _s, ...row } = solToken({ address: BNB_COIN, symbol: "FOUR", taxBps: 0 });
    h = await harness({ routes: { "GET /market/tokens": { items: [{ ...row, outside: { chain: "bnb", launchpad: "fourmeme", trendRank: 3 } }], nextCursor: null, total: 1 } } });
    const r = await call<{ coins: Record<string, unknown>[] }>(h, "get_board", {});
    expect(r.coins[0]).toMatchObject({ chain: "bnb", stage: "external", onPlatform: false, launchpad: "fourmeme", taxBps: null, launchType: null, url: `https://juststealthit.xyz/trending/${BNB_COIN}?chain=bnb` });
  });
});

describe("candles", () => {
  it("start at 1 minute: the 1 second interval is gone", async () => {
    h = await harness({ routes: { [`GET /sol/tokens/${MINT}`]: solToken() } });
    await h.client.listTools();
    const r = await h.client.callTool({ name: "get_candles", arguments: { address: MINT, interval: "1s" } });
    expect(r.isError).toBe(true);
    const tool = (await h.client.listTools()).tools.find((t) => t.name === "get_candles")!;
    expect((tool.inputSchema.properties as Record<string, { enum?: string[] }>).interval?.enum).toEqual(["1m", "5m", "15m", "1h", "4h", "1D"]);
  });
});

describe("get_trending", () => {
  const entry = (over: Record<string, unknown>) => ({ chain: "solana", address: MINT, symbol: "TEST", name: "Test", logo: null, priceUsd: 1, marketCapUsd: 1e6, changePct: 5, volume1hUsd: 1e4, onPlatform: true, launchpad: null, official: false, ...over });
  const routes = {
    "GET /market/trending": {
      coins: [entry({}), entry({ chain: "bnb", address: BNB_COIN, symbol: "FOUR", onPlatform: false, launchpad: "fourmeme" }), entry({ address: "So11111111111111111111111111111111111111113", symbol: "EXT", onPlatform: false, launchpad: "Pump.fun" })],
      outside: true,
    },
  };

  it("mixes coins launched here with external ones, each linked to its own page", async () => {
    h = await harness({ routes });
    const r = await call<{ coins: Record<string, unknown>[]; externalIncluded: boolean }>(h, "get_trending", { chains: ["solana", "bnb"] });
    expect(h.calls[0]!.url.searchParams.get("chains")).toBe("solana,bnb");
    expect(r.externalIncluded).toBe(true);
    expect(r.coins.map((c) => c.rank)).toEqual([1, 2, 3]);
    expect(r.coins[0]).toMatchObject({ onPlatform: true, url: `https://juststealthit.xyz/token/${MINT}` });
    expect(r.coins[1]).toMatchObject({ chain: "bnb", onPlatform: false, launchpad: "fourmeme", url: `https://juststealthit.xyz/trending/${BNB_COIN}?chain=bnb` });
  });

  it("filters by source", async () => {
    h = await harness({ routes });
    const ext = await call<{ coins: { symbol: string }[] }>(h, "get_trending", { source: "external" });
    expect(ext.coins.map((c) => c.symbol)).toEqual(["FOUR", "EXT"]);
    const own = await call<{ coins: { symbol: string; rank: number }[] }>(h, "get_trending", { source: "launched_here", limit: 1 });
    expect(own.coins).toEqual([expect.objectContaining({ symbol: "TEST", rank: 1 })]);
  });
});

describe("get_wallet_overview", () => {
  const OWNER = "GoDSW31bTxfkoup9yA1qcGGx9RMXdTEWgApv3xzBmoA";
  const holding = (symbol: string, valueUsd: number) => ({ token: solToken({ symbol }), balance: 10, valueEth: 0, valueUsd, costBasisEth: 0, pnlEth: 0, pnlUsd: 1, pnlPct: 1 });

  it("puts SOL, holdings, launches, staking and the EVM wallet in one answer", async () => {
    h = await harness({
      routes: {
        [`GET /sol/portfolio/${OWNER}`]: {
          owner: OWNER,
          ethBalance: 1.5,
          holdings: [holding("SMALL", 5), holding("BIG", 50)],
          launches: [{ token: solToken({ symbol: "MINE" }), fees: { unclaimedEth: 0.2, claimedEth: 1, recipient: OWNER, pendingRecipient: null } }],
          incomingOffers: [],
          totals: { holdingsUsd: 55, pnlUsd: 2, claimableEth: 0.2 },
        },
        "GET /staking": { enabled: false, pools: [] },
        [`GET /evm/wallets/${OWNER}`]: { exists: true, address: "0x00000000000000000000000000000000000000aa", chains: [{ chain: "base", chainId: 8453, native: "ETH", ok: true, balanceRaw: "1", balance: 0.01, usd: 30, maxWithdrawRaw: "1", tokens: [] }] },
      },
    });
    const r = await call<Record<string, any>>(h, "get_wallet_overview", { address: OWNER });
    expect(r.solBalance).toBe(1.5);
    expect(r.holdings.top.map((x: { symbol: string }) => x.symbol)).toEqual(["BIG", "SMALL"]);
    expect(r.launched).toMatchObject({ count: 1, claimableSol: 0.2 });
    expect(r.staking).toMatchObject({ state: "not_open", staked: null });
    expect(r.staking.message).toMatch(/opens soon/);
    expect(r.evmWallet).toMatchObject({ exists: true, totalUsd: 30 });
    expect(r.unavailable).toEqual([]);
  });

  it("says which parts it couldn't read, instead of reporting them empty", async () => {
    h = await harness({ routes: { "GET /staking": { enabled: false, pools: [] } } });
    const r = await call<Record<string, any>>(h, "get_wallet_overview", { address: OWNER });
    expect(r.holdings).toBeNull();
    expect(r.evmWallet).toBeNull();
    expect(r.unavailable.length).toBe(2);
  });
});

describe("live list resources", () => {
  it("reads and watches the Feed", async () => {
    let top = "a";
    const feedItemOf = (id: string) => ({ id, type: "event", at: Date.now(), author: null, event: { kind: "launch", chain: "solana", token: MINT, symbol: "TEST", name: "Test", usd: null, native: null, nativeSymbol: "SOL", txUrl: null, proofUrl: null } });
    h = await harness({ routes: { "GET /feed": () => ({ items: [feedItemOf(top)], next: null }) }, context: { feedPollMs: 20 } });
    const r = await h.client.readResource({ uri: "stealth://feed" });
    expect(JSON.parse(String((r.contents[0] as { text: string }).text)).items[0]).toMatchObject({ id: "a", kind: "launch" });
    await h.client.subscribeResource({ uri: "stealth://feed" });
    await new Promise((res) => setTimeout(res, 60));
    top = "b";
    await new Promise((res) => setTimeout(res, 120));
    expect(h.notifications.filter((n) => n.method === "notifications/resources/updated" && (n.params as { uri: string }).uri === "stealth://feed")).toHaveLength(1);
  });

  it("reads Trending and lists both live resources", async () => {
    h = await harness({ routes: { "GET /market/trending": { coins: [{ chain: "solana", address: MINT, symbol: "TEST", name: "Test", logo: null, priceUsd: 1, marketCapUsd: 1, changePct: 1, volume1hUsd: 1, onPlatform: true, launchpad: null, official: false }], outside: false } } });
    const r = JSON.parse(String(((await h.client.readResource({ uri: "stealth://trending" })).contents[0] as { text: string }).text));
    expect(r).toMatchObject({ externalIncluded: false, coins: [{ rank: 1, symbol: "TEST" }] });
    const uris = (await h.client.listResources()).resources.map((x) => x.uri);
    expect(uris).toEqual(expect.arrayContaining(["stealth://feed", "stealth://trending"]));
  });
});
