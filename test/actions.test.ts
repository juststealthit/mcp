import { decodeTransaction, feePayerOf } from "@juststealthit/sdk/solana";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";

import { MINT, call, callError, cosignedLegacyTx, harness, reply, solToken, swapTx, type Harness } from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const owner = Keypair.generate().publicKey;
const OWNER = owner.toBase58();

const swapQuote = (over: Record<string, unknown> = {}) => ({ venue: "curve", side: "buy", amountIn: "100000000", amountOut: "5000000000", minAmountOut: "4850000000", feeLamports: "2250000", feeBps: 225, priceImpactPct: 0.8, ...over });

const POOL = {
  id: "stealth",
  name: "$STEALTH",
  symbol: "STEALTH",
  receiptSymbol: "stSTEALTH",
  mint: "GoDSW31bTxfkoup9yA1qcGGx9RMXdTEWgApv3xzBmoA",
  receiptMint: MINT,
  decimals: 6,
  aprBps: 1_500,
  boosts: [{ days: 30, multBps: 12_000 }],
  cooldownSec: 21_600,
  depositLamports: 2_000_000,
  minAmount: "1000000",
  totalStaked: "5000000000000",
  stakers: 12,
  rewardPool: "100000000000",
};

describe("prepare_buy", () => {
  it("builds a buy on the coin's own venue, checked to be paid by the wallet, and sends nothing", async () => {
    h = await harness({
      routes: {
        [`GET /sol/tokens/${MINT}`]: solToken(),
        "POST /sol/swap": () => ({ transaction: swapTx(owner), quote: swapQuote(), lastValidBlockHeight: 99 }),
      },
    });
    const r = await call<Record<string, any>>(h, "prepare_buy", { address: MINT, amount: "0.1", wallet: OWNER });
    const swap = h.calls.find((c) => c.method === "POST")!;
    expect(swap.body).toMatchObject({ mint: MINT, owner: OWNER, side: "buy", amount: "100000000", slippageBps: 300 });
    expect(r).toMatchObject({ action: "buy", chain: "solana", wallet: OWNER, format: "solana-base64", preparedId: null, finishOnSite: `https://juststealthit.xyz/token/${MINT}` });
    expect(r.summary).toMatch(/Buy TEST on Solana through its bonding curve: 0\.1 SOL for about 5000 TEST/);
    expect(r.disclaimer).toMatch(/your own decision/);
    expect(r.nextSteps.join(" ")).toMatch(/Local signing is off/);
    const tx = decodeTransaction(r.transactions[0].transaction);
    expect(feePayerOf(tx)?.toBase58()).toBe(OWNER);
    // nothing was sent anywhere
    expect(h.calls.some((c) => c.path.startsWith("/sol/send"))).toBe(false);
  });

  it("refuses a transaction the API built for another wallet", async () => {
    h = await harness({
      routes: {
        [`GET /sol/tokens/${MINT}`]: solToken(),
        "POST /sol/swap": () => ({ transaction: swapTx(Keypair.generate().publicKey), quote: swapQuote(), lastValidBlockHeight: 99 }),
      },
    });
    const e = await callError(h, "prepare_buy", { address: MINT, amount: "0.1", wallet: OWNER });
    expect(e.error?.code).toBe("transaction_mismatch");
  });

  it("refuses while the anti-sniper fee is above the limit", async () => {
    h = await harness({
      routes: {
        [`GET /sol/tokens/${MINT}`]: solToken(),
        "POST /sol/swap": () => ({ transaction: swapTx(owner), quote: swapQuote({ feeBps: 7_225 }), lastValidBlockHeight: 99 }),
      },
    });
    const e = await callError(h, "prepare_buy", { address: MINT, amount: "0.1", wallet: OWNER });
    expect(e.error).toMatchObject({ code: "fee_too_high" });
    expect(e.text).toMatch(/72\.25%/);
  });

  it("routes a coin traded through Jupiter there", async () => {
    h = await harness({
      routes: {
        [`GET /sol/tokens/${MINT}`]: solToken({}, { swapVia: "jupiter" }),
        "POST /sol/market/swap": () => ({ transaction: swapTx(owner), quote: { side: "buy", amountIn: "100000000", amountOut: "7", minAmountOut: "6", priceImpactPct: 7.5, route: ["Raydium CPMM"] }, lastValidBlockHeight: 5 }),
      },
    });
    const r = await call<Record<string, any>>(h, "prepare_buy", { address: MINT, amount: "0.1", wallet: OWNER });
    expect(r.details).toMatchObject({ route: "jupiter", venue: "Raydium CPMM" });
    expect(r.warnings.join(" ")).toMatch(/moves the price about 7\.5%/);
  });

  it("asks for a wallet when there's none to default to", async () => {
    h = await harness({ routes: { [`GET /sol/tokens/${MINT}`]: solToken() } });
    const e = await callError(h, "prepare_buy", { address: MINT, amount: "0.1" });
    expect(e.error?.code).toBe("owner_required");
  });
});

describe("prepare_sell", () => {
  it("sells a share of the wallet's balance", async () => {
    h = await harness({
      routes: {
        [`GET /sol/tokens/${MINT}`]: solToken(),
        [`GET /sol/balance/${OWNER}`]: { lamports: "1", tokenBaseUnits: "8000000" },
        "POST /sol/swap": (c: { body: { amount: string } }) => ({ transaction: swapTx(owner), quote: swapQuote({ side: "sell", amountIn: c.body.amount, amountOut: "100" }), lastValidBlockHeight: 1 }),
      },
    });
    await call(h, "prepare_sell", { address: MINT, percent: 25, wallet: OWNER });
    expect(h.calls.find((c) => c.method === "POST")?.body).toMatchObject({ side: "sell", amount: "2000000" });
  });

  it("wants exactly one of amount and percent", async () => {
    h = await harness();
    expect((await callError(h, "prepare_sell", { address: MINT, wallet: OWNER })).error?.code).toBe("invalid_input");
    expect((await callError(h, "prepare_sell", { address: MINT, wallet: OWNER, amount: "1", percent: 5 })).error?.code).toBe("invalid_input");
  });
});

describe("staking", () => {
  it("prepare_stake returns the co-signed transaction and counts the first-stake deposit", async () => {
    const stakingWallet = Keypair.generate();
    h = await harness({
      routes: {
        "GET /staking": { enabled: true, network: "mainnet", pools: [POOL] },
        "POST /staking/stealth/stake": () => ({ actionId: 41, transaction: cosignedLegacyTx(owner, stakingWallet), depositLamports: 2_000_000, escrow: "esc" }),
      },
    });
    const r = await call<Record<string, any>>(h, "prepare_stake", { amount: "250", wallet: OWNER });
    expect(h.calls.find((c) => c.method === "POST")?.body).toEqual({ owner: OWNER, amount: "250000000" });
    expect(r.details).toMatchObject({ actionId: 41, depositSol: "0.002", receiptSymbol: "stSTEALTH" });
    expect(r.summary).toMatch(/deposits 0\.002 SOL/);
    expect(r.nextSteps.join(" ")).toMatch(/exactly as it came/);
  });

  it("prepare_stake refuses less than the pool's minimum", async () => {
    h = await harness({ routes: { "GET /staking": { enabled: true, pools: [POOL] } } });
    expect((await callError(h, "prepare_stake", { amount: "0.5", wallet: OWNER })).error?.code).toBe("below_minimum");
  });

  it("prepare_unstake unstakes a share of the position", async () => {
    const stakingWallet = Keypair.generate();
    h = await harness({
      routes: {
        "GET /staking": { enabled: true, pools: [POOL] },
        [`GET /staking/stealth/positions/${OWNER}`]: { owner: OWNER, escrow: "e", staked: "1000000000", unstaking: "0", rewardEarned: "0", rewardPaid: "0", openedAt: 1, boostBps: 10_000, nextBoost: null, wallet: { stake: "0", receipt: "1000000000" }, needsDeposit: false, unstakes: [], history: [] },
        "POST /staking/stealth/unstake": () => ({ actionId: 7, transaction: cosignedLegacyTx(owner, stakingWallet), unlockInSec: 21_600 }),
      },
    });
    const r = await call<Record<string, any>>(h, "prepare_unstake", { percent: 50, wallet: OWNER });
    expect(h.calls.find((c) => c.method === "POST")?.body).toEqual({ owner: OWNER, amount: "500000000" });
    expect(r.summary).toMatch(/about 6\.0 h/);
  });
});

describe("prepare_launch", () => {
  it("prepares a Solana launch and says what gets locked", async () => {
    const mint = Keypair.generate();
    h = await harness({
      routes: {
        "POST /sol/launch": () => ({
          transaction: swapTx(owner),
          version: "v0",
          mint: mint.publicKey.toBase58(),
          pool: "pool",
          escrow: "escrow",
          lastValidBlockHeight: 1,
          firstBuyTokens: "35000000000000",
          metadataUri: "ipfs://meta",
          feeMode: "buyback",
          venue: "meteora",
          taxTier: "m100",
        }),
      },
    });
    const r = await call<Record<string, any>>(h, "prepare_launch", { name: "Quiet Coin", symbol: "$QUIET", launchType: "buyback", venue: "meteora", taxTier: "m100", firstBuy: "0.05", wallet: OWNER });
    const body = h.calls.find((c) => c.method === "POST")?.body as Record<string, unknown>;
    expect(body).toMatchObject({ name: "Quiet Coin", symbol: "QUIET", feeMode: "buyback", venue: "meteora", firstBuyLamports: "50000000", launcher: OWNER });
    expect(r.summary).toMatch(/Meteora, tier m100, launch type Buy back and burn, with a first buy of 0\.05 SOL/);
    expect(r.summary).toMatch(/can't be undone/);
    expect(r.details.pageAfterLaunch).toBe(`https://juststealthit.xyz/token/${mint.publicKey.toBase58()}`);
  });

  it("refuses an EVM launch type that needs a stored fee plan", async () => {
    h = await harness();
    const e = await callError(h, "prepare_launch", { chain: "base", name: "X", symbol: "X", launchType: "mix", wallet: "0x0000000000000000000000000000000000000001" });
    expect(e.error?.code).toBe("invalid_input");
    expect(e.text).toMatch(/fee plan only the site can store/);
  });

  it("surfaces the API's validation issues", async () => {
    h = await harness({ routes: { "POST /sol/launch": reply(400, { error: "invalid_request", message: "Bad launch", issues: [{ path: "name", message: "too long" }] }) } });
    const e = await callError(h, "prepare_launch", { name: "X", symbol: "X", wallet: OWNER });
    expect(e.error).toMatchObject({ code: "invalid_request", details: { issues: [{ path: "name", message: "too long" }] } });
  });
});

describe("get_signing_status", () => {
  it("is prepare-only by default", async () => {
    h = await harness();
    expect(await call(h, "get_signing_status")).toMatchObject({ mode: "prepare-only", wallet: null, clientCanConfirm: false, keystoreWallets: [] });
  });
});
