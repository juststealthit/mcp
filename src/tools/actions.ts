/**
 * Action tools. Every `prepare_*` tool returns transactions for the user's own wallet to sign, with a plain-language summary and, where
 * the site has one, a page to finish on. Nothing is signed or sent unless local signing is on and the user confirms `sign_and_send`.
 *
 * @module
 */
import { StealthFeeTooHighError } from "@juststealthit/sdk";
import type { EvmDirectLaunchType, EvmTaxBps } from "@juststealthit/sdk/evm";
import type { MixSlice, SolanaLaunchInput, SolanaVenue } from "@juststealthit/sdk/solana";
import { formatUnits, isEvmAddress, isSolanaAddress, parseUnits } from "@juststealthit/sdk/utils";
import type { Address } from "viem";
import { z } from "zod";

import { prepareEvmLaunch, prepareEvmTrade, evmTokenBalance, type UnsignedEvmTx } from "../actions/evm.js";
import type { ActionKind, EncodedSolanaTx, PreparedAction } from "../actions/prepared.js";
import { lamportsToSolText } from "../actions/signing.js";
import { assertPaidBy, prepareSolanaLaunch, prepareSolanaTrade, solanaTokenBalance } from "../actions/solana.js";
import { isEvmChain, type EvmChain } from "../config.js";
import type { StealthContext } from "../context.js";
import { RefusedError } from "../errors.js";
import { LAUNCH_TYPES, iso, nullableString, short } from "../format.js";
import { AddressSchema, ChainSchema, resolveCoin, type ResolvedCoin } from "./coins.js";
import { PREPARE, READ, SIGN, defineTool, type ToolEnv } from "./define.js";
import { DecimalAmount } from "./maths.js";
import { PoolIdSchema, findPool } from "./staking.js";

export const DISCLAIMER =
  "Prepared for your own decision. Nothing here is advice or a promise of any return. Coins here are created by anyone, and you can lose everything you put in.";

const MaxFeeBps = z.number().int().min(0).max(9_000).default(1_000).describe("Refuse if the fee charged right now is above this, in bps. Default 1,000 (10%), which only a coin's first seconds reach");
const Slippage = z.number().int().min(10).max(5_000).optional().describe("Default: config.json's slippageBps, else 300");
const WalletInput = z.string().trim().optional().describe("The wallet that signs: a Solana address for Solana coins, an EVM address for EVM coins. Default: the keystore's wallet of that kind");

const PreparedOutput = {
  action: z.string(),
  chain: z.string(),
  wallet: z.string(),
  summary: z.string(),
  details: z.looseObject({}),
  format: z.enum(["solana-base64", "evm-unsigned"]).describe("solana-base64: wire-format transactions to sign in order. evm-unsigned: call objects to send in order"),
  transactions: z.array(z.looseObject({})),
  preparedId: nullableString.describe("Pass to sign_and_send to sign locally. Set only when local signing is on for this wallet"),
  expiresAt: nullableString,
  finishOnSite: nullableString,
  nextSteps: z.array(z.string()),
  warnings: z.array(z.string()),
  disclaimer: z.string(),
};

type PreparedData = z.infer<z.ZodObject<typeof PreparedOutput>>;

function solTxs(txs: EncodedSolanaTx[]) {
  return txs.map((t, i) => ({ step: i + 1, encoding: "base64", version: t.version, transaction: t.transaction }));
}

function evmTxs(txs: UnsignedEvmTx[]) {
  return txs.map((t, i) => ({ step: i + 1, ...t }));
}

/** Stores a Solana action for `sign_and_send` when the signer is this wallet. */
function stash(ctx: StealthContext, a: Omit<PreparedAction, "id" | "createdAt" | "expiresAt">): { preparedId: string | null; expiresAt: string | null } {
  if (!ctx.signer || ctx.signer.address !== a.owner) return { preparedId: null, expiresAt: null };
  const p = ctx.prepared.put(a);
  return { preparedId: p.id, expiresAt: iso(p.expiresAt) };
}

function solNextSteps(ctx: StealthContext, owner: string, preparedId: string | null): string[] {
  const steps = ["Sign each transaction in order with the wallet " + owner + ", then send it. A Solana transaction lapses about a minute after it was prepared; prepare again if it does."];
  if (preparedId) steps.unshift(`Or sign it here: call sign_and_send with preparedId ${preparedId}. You'll be asked to confirm.`);
  else if (!ctx.signer) steps.push("Local signing is off, so this server never signs. That's the default.");
  return steps;
}

const evmNextSteps = (from: string) => [`Send each call in order from ${from} with your own wallet. Gas is paid in the chain's coin. This server never signs EVM transactions.`];

async function solanaOwner(ctx: StealthContext, wallet?: string) {
  const owner = await ctx.defaultAddress("solana", wallet);
  if (!isSolanaAddress(owner)) throw new RefusedError("invalid_input", `${owner} isn't a Solana wallet address. This coin is on Solana.`);
  return owner;
}

async function evmFrom(ctx: StealthContext, wallet?: string): Promise<Address> {
  const from = await ctx.defaultAddress("evm", wallet);
  if (!isEvmAddress(from) && !/^0x[0-9a-fA-F]{40}$/.test(from)) throw new RefusedError("invalid_input", `${from} isn't an EVM wallet address. This coin is on an EVM chain.`);
  return from as Address;
}

function routeOf(coin: ResolvedCoin) {
  if (coin.kind === "sol") {
    const via = coin.token.sol.swapVia;
    if (via === null) throw new RefusedError("not_tradable", coin.token.sol.tradeMessage ?? `${coin.token.symbol} can't be traded here right now.`);
    return { route: via, decimals: coin.token.decimals ?? 6, symbol: coin.token.symbol, name: coin.token.name, onPlatform: true };
  }
  if (coin.kind === "external") {
    if (coin.coin.decimals === null) throw new RefusedError("unknown_decimals", "This token's decimals aren't known, so an amount can't be converted safely.");
    return { route: "jupiter" as const, decimals: coin.coin.decimals, symbol: coin.coin.symbol, name: coin.coin.name, onPlatform: coin.coin.onPlatform };
  }
  throw new Error("not a Solana coin");
}

const pct = (bps: number | null) => (bps === null ? "n/a" : `${(bps / 100).toFixed(2)}%`);

async function prepareTrade(side: "buy" | "sell", a: { address: string; chain?: z.infer<typeof ChainSchema>; amount?: string; percent?: number; slippageBps?: number; maxFeeBps: number; wallet?: string }, env: ToolEnv): Promise<{ data: PreparedData; summary: string }> {
  const { ctx, signal } = env;
  const slippage = a.slippageBps ?? ctx.config.slippageBps;
  const coin = await resolveCoin(ctx, a.address, a.chain, signal);
  const warnings: string[] = [];

  if (coin.kind === "evm") {
    const from = await evmFrom(ctx, a.wallet);
    let raw: bigint;
    if (side === "buy") raw = parseUnits(a.amount!, 18);
    else if (a.percent !== undefined) {
      const bal = await evmTokenBalance(ctx, coin.chain, coin.address as Address, from);
      raw = (bal * BigInt(Math.round(a.percent * 100))) / 10_000n;
    } else raw = parseUnits(a.amount!, 18);
    if (raw <= 0n) throw new RefusedError("nothing_to_sell", "That comes to zero tokens. Check the wallet's balance.");
    const t = await prepareEvmTrade(ctx, { chain: coin.chain, token: coin.address as Address, side, from, amount: raw, slippageBps: slippage, maxFeeBps: a.maxFeeBps });
    const native = coin.token.evm.native;
    const [inU, outU] = side === "buy" ? [native, coin.token.symbol] : [coin.token.symbol, native];
    const summary = `${side === "buy" ? "Buy" : "Sell"} ${coin.token.symbol} on ${coin.chain}: ${short(formatUnits(BigInt(t.quote.amountIn), 18))} ${inU} for about ${short(formatUnits(BigInt(t.quote.amountOut), 18))} ${outU} (at least ${short(formatUnits(BigInt(t.quote.minAmountOut), 18))}, slippage ${slippage / 100}%). Fee right now ${pct(t.quote.feeBps)}. ${t.transactions.length} transaction${t.transactions.length === 1 ? "" : "s"} for ${from} to sign; the swap reverts after ${new Date(t.deadline * 1000).toISOString()}.`;
    if (t.quote.feeBps > coin.token.taxBps) warnings.push(`The anti-sniper fee is still above the coin's ${coin.token.taxBps / 100}% tax. Waiting a few seconds lowers it.`);
    return {
      data: {
        action: side,
        chain: coin.chain,
        wallet: from,
        summary,
        details: { coin: { address: coin.address, symbol: coin.token.symbol, name: coin.token.name }, quote: t.quote, slippageBps: slippage, router: t.router, deadline: iso(t.deadline * 1000) },
        format: "evm-unsigned",
        transactions: evmTxs(t.transactions),
        preparedId: null,
        expiresAt: iso(t.deadline * 1000),
        finishOnSite: ctx.links.coin(coin.address),
        nextSteps: evmNextSteps(from),
        warnings,
        disclaimer: DISCLAIMER,
      },
      summary,
    };
  }

  const owner = await solanaOwner(ctx, a.wallet);
  const r = routeOf(coin);
  let raw: bigint;
  if (side === "buy") raw = parseUnits(a.amount!, 9);
  else if (a.percent !== undefined) {
    const bal = await solanaTokenBalance(ctx, owner, coin.address, signal);
    raw = (bal * BigInt(Math.round(a.percent * 100))) / 10_000n;
  } else raw = parseUnits(a.amount!, r.decimals);
  if (raw <= 0n) throw new RefusedError("nothing_to_sell", "That comes to zero tokens. Check the wallet's balance.");
  const t = await prepareSolanaTrade(ctx, { mint: coin.address, side, owner, amount: raw, slippageBps: slippage, route: r }, signal);
  if (t.quote.feeBps !== null && t.quote.feeBps > a.maxFeeBps) throw new StealthFeeTooHighError(t.quote.feeBps, a.maxFeeBps);
  if (!t.onPlatform) warnings.push("This token wasn't launched on Just Stealth It. It trades through Jupiter.");
  if (t.quote.priceImpactPct !== null && t.quote.priceImpactPct > 5) warnings.push(`This trade moves the price about ${t.quote.priceImpactPct.toFixed(1)}%.`);
  const [inDec, outDec, inU, outU] = side === "buy" ? [9, t.tokenDecimals, "SOL", t.symbol] : [t.tokenDecimals, 9, t.symbol, "SOL"];
  const where = t.route === "app" ? (t.venue === "curve" ? "its bonding curve" : "its pool") : `Jupiter (${t.venue})`;
  const summary = `${side === "buy" ? "Buy" : "Sell"} ${t.symbol} on Solana through ${where}: ${short(formatUnits(BigInt(t.quote.amountIn), inDec))} ${inU} for about ${short(formatUnits(BigInt(t.quote.amountOut), outDec))} ${outU} (at least ${short(formatUnits(BigInt(t.quote.minAmountOut), outDec))}, slippage ${slippage / 100}%). Fee right now ${t.quote.feeBps === null ? "set by the route" : pct(t.quote.feeBps)}. Wallet ${owner}.`;
  const spend = side === "buy" ? BigInt(t.quote.amountIn) : 0n;
  const held = stash(ctx, { kind: side as ActionKind, chain: "solana", owner, summary, spendLamports: spend, feeBps: t.quote.feeBps, maxFeeBps: a.maxFeeBps, transactions: t.transactions, bundle: false, stakingActionId: null, mint: coin.address });
  return {
    data: {
      action: side,
      chain: "solana",
      wallet: owner,
      summary,
      details: { coin: { address: coin.address, symbol: t.symbol, name: t.name }, route: t.route, venue: t.venue, quote: t.quote, slippageBps: slippage, spendSol: lamportsToSolText(spend), lastValidBlockHeight: t.lastValidBlockHeight },
      format: "solana-base64" as const,
      transactions: solTxs(t.transactions),
      ...held,
      finishOnSite: ctx.links.coin(coin.address),
      nextSteps: solNextSteps(ctx, owner, held.preparedId),
      warnings,
      disclaimer: DISCLAIMER,
    },
    summary,
  };
}

export const prepareBuy = defineTool({
  name: "prepare_buy",
  title: "Prepare a buy",
  description:
    "Builds a buy of a coin for the user's own wallet to sign: on its bonding curve or pool for a launchpad coin, through Jupiter for any other Solana token, or through the chain's router on EVM. Returns the transaction(s), a plain summary, the token page to finish on, and nothing is sent. Refuses while the anti-sniper fee is above maxFeeBps.",
  input: { address: AddressSchema, chain: ChainSchema.optional(), amount: DecimalAmount.describe("The native coin to spend: SOL, ETH, BNB, HYPE or USDC"), slippageBps: Slippage, maxFeeBps: MaxFeeBps, wallet: WalletInput },
  output: PreparedOutput,
  annotations: PREPARE,
  async run(a, env) {
    return prepareTrade("buy", a, env);
  },
});

export const prepareSell = defineTool({
  name: "prepare_sell",
  title: "Prepare a sell",
  description: "Builds a sell of a coin for the user's own wallet to sign, by amount or by a percentage of the wallet's balance. Returns the transaction(s), a plain summary and the token page; nothing is sent.",
  input: {
    address: AddressSchema,
    chain: ChainSchema.optional(),
    amount: DecimalAmount.optional().describe("Whole tokens to sell"),
    percent: z.number().min(0.01).max(100).optional().describe("Or a share of the wallet's balance, 0.01 to 100"),
    slippageBps: Slippage,
    maxFeeBps: MaxFeeBps,
    wallet: WalletInput,
  },
  output: PreparedOutput,
  annotations: PREPARE,
  async run(a, env) {
    if ((a.amount === undefined) === (a.percent === undefined)) throw new RefusedError("invalid_input", "Give either amount or percent.");
    return prepareTrade("sell", a, env);
  },
});

export const prepareStake = defineTool({
  name: "prepare_stake",
  title: "Prepare a stake",
  description:
    "Builds a $STEALTH stake for the user's Solana wallet to sign. The staking wallet co-signs it first; the user's signature completes it. A first stake also puts a small SOL deposit in the staker's escrow, returned when everything is unstaked. Rewards are estimates, never promises.",
  input: { amount: DecimalAmount.describe("Whole tokens to stake"), pool: PoolIdSchema, wallet: WalletInput },
  output: PreparedOutput,
  annotations: PREPARE,
  async run(a, { ctx, signal }) {
    const owner = await solanaOwner(ctx, a.wallet);
    const pool = await findPool(ctx, a.pool, signal);
    const raw = parseUnits(a.amount, pool.decimals);
    if (raw < BigInt(pool.minAmount)) throw new RefusedError("below_minimum", `The least you can stake is ${formatUnits(BigInt(pool.minAmount), pool.decimals)} ${pool.symbol}.`);
    const p = await ctx.client.staking.prepareStake(pool.id, owner, raw, { signal });
    const txs: EncodedSolanaTx[] = [{ transaction: p.transaction, version: "legacy" }];
    assertPaidBy(txs, owner);
    const deposit = BigInt(p.depositLamports);
    const summary = `Stake ${a.amount} ${pool.symbol} in the ${pool.name} pool from ${owner}, receiving ${a.amount} ${pool.receiptSymbol} as the receipt.${deposit > 0n ? ` A first stake also deposits ${lamportsToSolText(deposit)} SOL into your escrow, returned when you've unstaked everything.` : ""} Unstaking takes ${pool.cooldownSec / 3_600} h.`;
    const held = stash(ctx, { kind: "stake", chain: "solana", owner, summary, spendLamports: deposit, feeBps: null, maxFeeBps: null, transactions: txs, bundle: false, stakingActionId: p.actionId, mint: pool.mint });
    return {
      data: {
        action: "stake",
        chain: "solana",
        wallet: owner,
        summary,
        details: { pool: pool.id, amount: a.amount, symbol: pool.symbol, receiptSymbol: pool.receiptSymbol, depositSol: lamportsToSolText(deposit), escrow: p.escrow, actionId: p.actionId, aprPct: pool.aprBps / 100 },
        format: "solana-base64" as const,
        transactions: solTxs(txs),
        ...held,
        finishOnSite: ctx.links.home(),
        nextSteps: [
          ...solNextSteps(ctx, owner, held.preparedId).slice(0, held.preparedId ? 1 : 0),
          `Sign the transaction exactly as it came, without rebuilding it (the staking wallet has already signed), then submit it through the staking API with action id ${p.actionId}. Or stake from Wallet → Stake on the site.`,
          `Keep the ${pool.receiptSymbol} in this wallet: it is what unstakes.`,
        ],
        warnings: ["Staking isn't audited. The staking escrow's key is held by Just Stealth It."],
        disclaimer: DISCLAIMER,
      },
      summary,
    };
  },
});

export const prepareUnstake = defineTool({
  name: "prepare_unstake",
  title: "Prepare an unstake",
  description: "Builds an unstake for the user's Solana wallet to sign, by amount or a percentage of what's staked. The coins and their share of rewards come back by themselves after the pool's cooldown.",
  input: {
    amount: DecimalAmount.optional().describe("Whole receipt tokens to hand back"),
    percent: z.number().min(0.01).max(100).optional().describe("Or a share of what's staked"),
    pool: PoolIdSchema,
    wallet: WalletInput,
  },
  output: PreparedOutput,
  annotations: PREPARE,
  async run(a, { ctx, signal }) {
    if ((a.amount === undefined) === (a.percent === undefined)) throw new RefusedError("invalid_input", "Give either amount or percent.");
    const owner = await solanaOwner(ctx, a.wallet);
    const pool = await findPool(ctx, a.pool, signal);
    let raw: bigint;
    if (a.percent !== undefined) {
      const pos = await ctx.client.staking.position(pool.id, owner, { signal });
      raw = (BigInt(pos.staked) * BigInt(Math.round(a.percent * 100))) / 10_000n;
    } else raw = parseUnits(a.amount!, pool.decimals);
    if (raw <= 0n) throw new RefusedError("nothing_staked", "That comes to zero. Check what this wallet has staked.");
    const p = await ctx.client.staking.prepareUnstake(pool.id, owner, raw, { signal });
    const txs: EncodedSolanaTx[] = [{ transaction: p.transaction, version: "legacy" }];
    assertPaidBy(txs, owner);
    const amount = formatUnits(raw, pool.decimals);
    const summary = `Unstake ${amount} ${pool.symbol} from the ${pool.name} pool, handing back ${amount} ${pool.receiptSymbol}. It comes back to ${owner} with its share of rewards about ${(p.unlockInSec / 3_600).toFixed(1)} h after it confirms.`;
    const held = stash(ctx, { kind: "unstake", chain: "solana", owner, summary, spendLamports: 0n, feeBps: null, maxFeeBps: null, transactions: txs, bundle: false, stakingActionId: p.actionId, mint: pool.mint });
    return {
      data: {
        action: "unstake",
        chain: "solana",
        wallet: owner,
        summary,
        details: { pool: pool.id, amount, actionId: p.actionId, unlockInSec: p.unlockInSec },
        format: "solana-base64" as const,
        transactions: solTxs(txs),
        ...held,
        finishOnSite: ctx.links.home(),
        nextSteps: [...(held.preparedId ? [`Or sign it here: call sign_and_send with preparedId ${held.preparedId}.`] : []), `Sign it exactly as it came and submit it through the staking API with action id ${p.actionId}, or unstake from Wallet → Stake on the site.`],
        warnings: [],
        disclaimer: DISCLAIMER,
      },
      summary,
    };
  },
});

const SOLANA_TYPES = ["creator", "social", "team", "wallet", "marketing", "holders", "diamond", "buyback", "feed", "liquidity", "mix"] as const;
const EVM_TYPES = ["creator", "team", "marketing", "holders", "buyback"] as const;
const Socials = z.object({
  twitter: z.string().max(256).optional(),
  telegram: z.string().max(256).optional(),
  website: z.string().max(256).optional(),
  discord: z.string().max(256).optional(),
  farcaster: z.string().max(256).optional(),
});
const TeamMember = z.object({ wallet: z.string(), bps: z.number().int().min(1).max(10_000) });

const LaunchInput = {
  chain: ChainSchema.optional().describe("Default: config.json's defaultChain, else solana"),
  name: z.string().trim().min(1).max(32),
  symbol: z.string().trim().min(1).max(10).describe("The ticker, without $"),
  description: z.string().max(1_000).optional(),
  logo: z.string().max(512).regex(/^(https:\/\/|ipfs:\/\/)/, "an https:// or ipfs:// URL").optional(),
  socials: Socials.optional(),
  launchType: z.enum(SOLANA_TYPES).default("creator").describe("Where creator fees go, locked at launch. EVM chains take creator, team, marketing, holders or buyback"),
  firstBuy: DecimalAmount.optional().describe("A first buy in the native coin, made in the launch itself (capped at 5% of supply)"),
  venue: z.enum(["pump", "raydium", "meteora"]).optional().describe("Solana only. Default: the server's default"),
  taxTier: z.string().regex(/^[a-z]\d{3}$/).optional().describe("Solana Raydium/Meteora tier id from get_launch_options, such as t225 or m180"),
  quoteMint: z.string().optional().describe("Solana only: the pair, if not SOL"),
  team: z.array(TeamMember).min(2).max(10).optional().describe("Team type: wallets and shares adding up to 10,000 bps"),
  payout: z.object({ chainId: z.number().int(), address: z.string() }).optional().describe("Wallet type (Solana): where creator fees go"),
  feedMint: z.string().optional().describe("Feed a Coin type (Solana): the coin to buy and burn"),
  mix: z.array(z.object({ kind: z.string(), bps: z.number().int().min(100), team: z.array(TeamMember).optional(), payout: z.object({ chainId: z.number().int(), address: z.string() }).optional(), feedMint: z.string().optional() })).min(2).max(5).optional(),
  socialAccount: z
    .object({
      provider: z.enum(["x", "twitch", "github", "tiktok"]),
      handle: z.string().min(1).max(64),
      acknowledged: z.literal(true).describe("The user confirms the named person hasn't agreed to anything and doesn't endorse the coin"),
    })
    .optional()
    .describe("Social type: the account whose vault receives the fees. The launcher gets none"),
  taxBps: z.union([z.literal(125), z.literal(225), z.literal(325), z.literal(425), z.literal(575)]).optional().describe("EVM only. Default 125"),
  maxWalletBps: z.number().int().min(0).max(500).optional().describe("EVM only: 50 to 500, for limitsWindowSec"),
  maxBuyBps: z.number().int().min(0).max(500).optional().describe("EVM only: 10 to 500, for limitsWindowSec"),
  limitsWindowSec: z.number().int().min(0).max(3_600).optional(),
  firstBuyLockSec: z.number().int().min(0).max(90 * 86_400).optional().describe("EVM only: lock the first-buy tokens for up to 90 days"),
  wallet: WalletInput,
};

export const prepareLaunch = defineTool({
  name: "prepare_launch",
  title: "Prepare a launch",
  description:
    "Builds a coin launch for the user's own wallet to sign. On Solana the API builds it (it holds the new coin's escrow key and signs for the mint); on EVM chains it's built direct against the factory. Venue, pair, tax tier and launch type are locked once it lands, and a launch can't be undone or refunded. Call get_launch_options first.",
  input: LaunchInput,
  output: PreparedOutput,
  annotations: PREPARE,
  async run(a, { ctx, signal }) {
    const chain = a.chain ?? ctx.config.defaultChain;
    const typeInfo = LAUNCH_TYPES[a.launchType]!;
    if (isEvmChain(chain)) return evmLaunch(ctx, chain, a);

    const owner = await solanaOwner(ctx, a.wallet);
    let recipient: SolanaLaunchInput["recipient"];
    if (a.launchType === "social") {
      if (!a.socialAccount) throw new RefusedError("invalid_input", "A Social launch needs socialAccount: the provider and handle whose vault gets the fees.");
      const found = await ctx.client.social.lookup(a.socialAccount.provider, a.socialAccount.handle.replace(/^@/, ""), { signal });
      // the user acknowledged it in the input: the server never does on their behalf
      recipient = { kind: "social", provider: a.socialAccount.provider, handle: found.handle, accountId: found.accountId, acknowledged: a.socialAccount.acknowledged };
    }
    const firstBuy = a.firstBuy ? parseUnits(a.firstBuy, 9) : 0n;
    const input: SolanaLaunchInput = {
      venue: a.venue as SolanaVenue | undefined,
      taxTier: a.taxTier,
      name: a.name,
      symbol: a.symbol.replace(/^\$/, ""),
      description: a.description,
      logo: a.logo,
      socials: a.socials,
      firstBuyLamports: firstBuy,
      quoteMint: a.quoteMint,
      feeMode: a.launchType,
      team: a.team,
      payout: a.payout,
      feed: a.feedMint ? { mint: a.feedMint } : undefined,
      mix: a.mix?.map((s) => ({ kind: s.kind, bps: s.bps, team: s.team, payout: s.payout, feed: s.feedMint ? { mint: s.feedMint } : undefined })) as MixSlice[] | undefined,
      recipient,
    };
    const { prepared, transactions } = await prepareSolanaLaunch(ctx, owner, input);
    const venueName = prepared.venue === "pump" ? "Pump.fun" : prepared.venue === "raydium" ? "Raydium LaunchLab" : "Meteora";
    const summary = `Launch ${a.name} ($${input.symbol}) on Solana through ${venueName}${prepared.taxTier ? `, tier ${prepared.taxTier}` : ""}, launch type ${typeInfo.label}${firstBuy > 0n ? `, with a first buy of ${a.firstBuy} SOL` : ", with no first buy"}. Paid by ${owner}. Locked once it lands: venue, pair, tier and launch type. It can't be undone or refunded.`;
    const held = stash(ctx, { kind: "launch", chain: "solana", owner, summary, spendLamports: firstBuy, feeBps: null, maxFeeBps: null, transactions, bundle: prepared.bundle === true, stakingActionId: null, mint: prepared.mint });
    return {
      data: {
        action: "launch",
        chain: "solana",
        wallet: owner,
        summary,
        details: {
          mint: prepared.mint,
          pool: prepared.pool,
          escrow: prepared.escrow,
          venue: prepared.venue,
          taxTier: prepared.taxTier,
          launchType: a.launchType,
          launchTypeSummary: typeInfo.summary,
          firstBuySol: a.firstBuy ?? "0",
          expectedFirstBuyTokens: prepared.firstBuyTokens,
          metadataUri: prepared.metadataUri,
          bundle: prepared.bundle === true,
          pageAfterLaunch: ctx.links.coin(prepared.mint),
        },
        format: "solana-base64" as const,
        transactions: solTxs(transactions),
        ...held,
        finishOnSite: ctx.links.home(),
        nextSteps: [
          ...solNextSteps(ctx, owner, held.preparedId),
          ...(prepared.bundle ? ["These transactions must land together as one bundle."] : []),
          `The token page will be ${ctx.links.coin(prepared.mint)} once it lands.`,
        ],
        warnings: ["Network fees and account rent come on top of the first buy."],
        disclaimer: DISCLAIMER,
      },
      summary,
    };
  },
});

async function evmLaunch(ctx: StealthContext, chain: EvmChain, a: z.infer<z.ZodObject<typeof LaunchInput>>) {
  if (!(EVM_TYPES as readonly string[]).includes(a.launchType)) {
    throw new RefusedError("invalid_input", `A direct EVM launch takes ${EVM_TYPES.join(", ")}. Other types need a fee plan only the site can store: launch those on the site.`);
  }
  if (a.venue || a.taxTier || a.quoteMint || a.payout || a.feedMint || a.mix || a.socialAccount) throw new RefusedError("invalid_input", "venue, taxTier, quoteMint, payout, feedMint, mix and socialAccount are Solana options.");
  const from = await evmFrom(ctx, a.wallet);
  const firstBuy = a.firstBuy ? parseUnits(a.firstBuy, 18) : 0n;
  const { prepared, transactions } = await prepareEvmLaunch(ctx, chain, from, {
    name: a.name,
    symbol: a.symbol.replace(/^\$/, ""),
    logo: a.logo,
    description: a.description,
    socials: a.socials,
    taxBps: (a.taxBps ?? 125) as EvmTaxBps,
    firstBuy,
    launchType: a.launchType as EvmDirectLaunchType,
    team: a.team?.map((m) => ({ wallet: m.wallet as Address, bps: m.bps })),
    maxWalletBps: a.maxWalletBps,
    maxBuyBps: a.maxBuyBps,
    limitsWindow: a.limitsWindowSec,
    firstBuyLock: a.firstBuyLockSec,
  });
  const native = ctx.evm(chain).deployment.native;
  const typeInfo = LAUNCH_TYPES[a.launchType]!;
  const summary = `Launch ${a.name} ($${a.symbol}) on ${ctx.evm(chain).deployment.name} at a ${(a.taxBps ?? 125) / 100}% tax, launch type ${typeInfo.label}${firstBuy > 0n ? `, first buy ${a.firstBuy} ${native}` : ""}. Sends ${formatUnits(prepared.value, 18)} ${native} from ${from}. The token should land at ${prepared.predictedToken}. Locked once it lands; it can't be undone or refunded.`;
  return {
    data: {
      action: "launch",
      chain,
      wallet: from,
      summary,
      details: {
        predictedToken: prepared.predictedToken,
        valueNative: formatUnits(prepared.value, 18),
        expectedFirstBuyTokens: formatUnits(prepared.expectedTokens, 18),
        launchType: a.launchType,
        launchTypeSummary: typeInfo.summary,
        taxBps: a.taxBps ?? 125,
        pageAfterLaunch: ctx.links.coin(prepared.predictedToken),
      },
      format: "evm-unsigned" as const,
      transactions: evmTxs(transactions),
      preparedId: null,
      expiresAt: null,
      finishOnSite: ctx.links.home(),
      nextSteps: [...evmNextSteps(from), "The factory rejects a launch built against an old config: if it reverts with StaleConfig, prepare it again."],
      warnings: ["The EVM contracts are not audited."],
      disclaimer: DISCLAIMER,
    },
    summary,
  };
}

export const signAndSend = defineTool({
  name: "sign_and_send",
  title: "Sign and send",
  description:
    "Signs a prepared Solana action with the local keystore wallet and sends it. Only present when local signing is on. Checks the wallet, the fee limit and the per-transaction and daily SOL caps from config.json, then asks the user to confirm in the client. Spends real money and can't be undone.",
  input: { preparedId: z.string().regex(/^prep_[A-Za-z0-9_-]{6,32}$/) },
  output: {
    status: z.enum(["confirmed", "sent", "declined", "cancelled"]),
    action: z.string(),
    signatures: z.array(z.string()),
    explorer: z.array(z.string().nullable()),
    spentSol: z.string(),
    spentLast24hSol: z.string(),
    dailyCapSol: z.number(),
    page: nullableString,
  },
  annotations: SIGN,
  async run(a, { ctx, server, signal }) {
    const signer = ctx.signer;
    if (!signer) throw new RefusedError("signing_disabled", "Local signing is off. Sign the prepared transactions in your own wallet.");
    const action = ctx.prepared.peek(a.preparedId);
    if (!action) throw new RefusedError("unknown_or_expired", "No prepared action with that id: it was used, or it expired (they last about a minute). Prepare it again.");
    signer.check(action);
    const answer = await signer.confirm(server.server, action, signal);
    const base = { action: action.kind, signatures: [], explorer: [], spentSol: "0", dailyCapSol: signer.caps.maxSolPerDay, page: action.mint ? ctx.links.coin(action.mint) : null };
    if (answer === "declined" || answer === "cancelled") {
      return { data: { ...base, status: answer, spentLast24hSol: lamportsToSolText(await signer.spentLastDay()) }, summary: `Not sent: the confirmation was ${answer}.` };
    }
    if (answer === "not_supported") {
      if (signer.requireElicitation) throw new RefusedError("confirmation_unavailable", "This client can't show a confirmation, and the server was started with --require-elicitation. Nothing was sent.");
      ctx.logger.warn("signing without an in-client confirmation: the client doesn't support elicitation", { action: action.kind });
    }
    const taken = ctx.prepared.take(action.id);
    if (!taken) throw new RefusedError("unknown_or_expired", "The prepared action expired while waiting for confirmation. Prepare it again.");
    const r = await signer.execute(ctx, taken);
    const spent = await signer.spentLastDay();
    return {
      data: { ...base, status: r.status, signatures: r.signatures, explorer: r.explorer, spentSol: lamportsToSolText(taken.spendLamports), spentLast24hSol: lamportsToSolText(spent) },
      summary: `${r.status === "confirmed" ? "Confirmed" : "Sent"}: ${r.signatures.join(", ")}.`,
    };
  },
});

export const getSigningStatus = defineTool({
  name: "get_signing_status",
  title: "Signing status",
  description: "Whether this server can sign (it can't by default), which keystore wallet it would use, the SOL caps from config.json, what was spent in the last 24 hours, and whether this client can show a confirmation. Lists the keystore's public addresses.",
  input: {},
  output: {
    mode: z.enum(["prepare-only", "local-signing"]),
    reason: nullableString,
    wallet: z.object({ name: z.string(), address: z.string() }).nullable(),
    caps: z.object({ maxSolPerTx: z.number(), maxSolPerDay: z.number() }),
    spentLast24hSol: nullableString,
    clientCanConfirm: z.boolean(),
    requireConfirmation: z.boolean(),
    keystoreWallets: z.array(z.object({ name: z.string(), kind: z.string(), address: z.string() })),
  },
  annotations: { ...READ, openWorldHint: false },
  async run(_a, { ctx, server }) {
    const wallets = await ctx.wallets();
    const s = ctx.signer;
    return {
      data: {
        mode: s ? ("local-signing" as const) : ("prepare-only" as const),
        reason: s ? null : (ctx.signingOffReason ?? "Off by default. Start the server with --allow-signing to sign with a keystore wallet."),
        wallet: s ? { name: s.walletName, address: s.address } : null,
        caps: s ? s.caps : { maxSolPerTx: ctx.config.mcp.maxSolPerTx, maxSolPerDay: ctx.config.mcp.maxSolPerDay },
        spentLast24hSol: s ? lamportsToSolText(await s.spentLastDay()) : null,
        clientCanConfirm: !!server.server.getClientCapabilities()?.elicitation,
        requireConfirmation: s?.requireElicitation ?? false,
        keystoreWallets: wallets.map((w) => ({ name: w.name, kind: w.kind, address: w.address })),
      },
    };
  },
});

export const getTransactionStatus = defineTool({
  name: "get_transaction_status",
  title: "Transaction status",
  description: "Whether a Solana transaction is pending, confirmed or failed, read right after it was sent. An old signature reads pending; check the explorer link for those.",
  input: { signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/, "a base58 Solana signature") },
  output: { signature: z.string(), status: z.string(), error: nullableString, explorer: nullableString },
  annotations: { ...READ, idempotentHint: false },
  async run(a, { ctx, signal }) {
    const s = await ctx.client.sol.txStatus(a.signature, { signal });
    return { data: { signature: a.signature, status: s.status, error: s.error, explorer: ctx.links.tx("solana", a.signature) } };
  },
});

export const actionTools = [prepareBuy, prepareSell, prepareStake, prepareUnstake, prepareLaunch, getSigningStatus, getTransactionStatus];
