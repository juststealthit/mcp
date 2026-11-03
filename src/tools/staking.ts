/**
 * $STEALTH staking reads and the reward estimate.
 *
 * @module
 */
import type { StakePool, StakePosition } from "@juststealthit/sdk/api";
import { effectiveAprBps, estimateStakingReward } from "@juststealthit/sdk/math";
import { formatUnits, isSolanaAddress, parseUnits } from "@juststealthit/sdk/utils";
import { z } from "zod";

import type { StealthContext } from "../context.js";
import { NotFoundError, RefusedError } from "../errors.js";
import { iso, nullableString } from "../format.js";
import { PURE, READ, defineTool } from "./define.js";

export const PoolIdSchema = z.string().trim().regex(/^[a-z0-9_-]{1,32}$/i).default("stealth").describe("Pool id. $STEALTH's is `stealth`");

const fmt = (raw: string | number | bigint, decimals: number) => formatUnits(BigInt(String(raw).split(".")[0] ?? "0"), decimals);

export const PoolViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  receiptSymbol: z.string(),
  mint: z.string(),
  receiptMint: z.string(),
  decimals: z.number(),
  aprPct: z.number().describe("Today's base yearly rate. It can change"),
  boosts: z.array(z.object({ afterDays: z.number(), multiplier: z.number() })),
  cooldownHours: z.number().describe("How long an unstake waits before the coins come back"),
  firstStakeDepositSol: z.number().describe("SOL a first stake puts in the staker's escrow, returned when the last unstake is released"),
  minAmount: z.string(),
  totalStaked: z.string(),
  stakers: z.number(),
  rewardPool: z.string().describe("What the reward pool can still pay"),
});

export function poolView(p: StakePool) {
  return {
    id: p.id,
    name: p.name,
    symbol: p.symbol,
    receiptSymbol: p.receiptSymbol,
    mint: p.mint,
    receiptMint: p.receiptMint,
    decimals: p.decimals,
    aprPct: p.aprBps / 100,
    boosts: p.boosts.map((b) => ({ afterDays: b.days, multiplier: b.multBps / 10_000 })),
    cooldownHours: p.cooldownSec / 3_600,
    firstStakeDepositSol: p.depositLamports / 1e9,
    minAmount: fmt(p.minAmount, p.decimals),
    totalStaked: fmt(p.totalStaked, p.decimals),
    stakers: p.stakers,
    rewardPool: fmt(p.rewardPool, p.decimals),
  };
}

export async function findPool(ctx: StealthContext, id: string, signal?: AbortSignal): Promise<StakePool> {
  const o = await ctx.client.staking.overview({ signal });
  if (!o.enabled) throw new RefusedError("staking_closed", "Staking isn't open yet. It's built and tested, and opens soon.");
  const p = o.pools.find((x) => x.id === id);
  if (!p) throw new NotFoundError(`No staking pool "${id}". Pools: ${o.pools.map((x) => x.id).join(", ") || "none"}.`);
  return p;
}

export function positionView(p: StakePosition, decimals: number) {
  return {
    owner: p.owner,
    staked: fmt(p.staked, decimals),
    unstaking: fmt(p.unstaking, decimals),
    rewardEarned: fmt(p.rewardEarned, decimals),
    rewardPaid: fmt(p.rewardPaid, decimals),
    openedAt: iso(p.openedAt),
    boostMultiplier: p.boostBps / 10_000,
    nextBoost: p.nextBoost ? { multiplier: p.nextBoost.multBps / 10_000, at: iso(p.nextBoost.at) } : null,
    walletBalance: fmt(p.wallet.stake, decimals),
    receiptBalance: fmt(p.wallet.receipt, decimals),
    needsDeposit: p.needsDeposit,
    unstakes: p.unstakes.map((u) => ({ amount: fmt(u.amount, decimals), reward: fmt(u.reward, decimals), unlockAt: iso(u.unlockAt), status: u.status, releaseTx: u.releaseSig })),
    history: p.history.slice(0, 20).map((h) => ({ kind: h.kind, amount: fmt(h.amount, decimals), at: iso(h.at), tx: h.sig })),
  };
}

export const getStakingPools = defineTool({
  name: "get_staking_pools",
  title: "Staking pools",
  description:
    "The $STEALTH staking pools: today's yearly rate and boosts, cooldown, the first-stake SOL deposit, total staked, stakers and what the reward pool can still pay. Rates can change and rewards stop while the reward pool is empty; nothing here promises a return.",
  input: {},
  output: { enabled: z.boolean(), network: nullableString, pools: z.array(PoolViewSchema) },
  annotations: READ,
  async run(_a, { ctx, signal }) {
    const o = await ctx.client.staking.overview({ signal });
    const pools = o.pools.map(poolView);
    return { data: { enabled: o.enabled, network: o.network ?? null, pools }, summary: o.enabled ? `${pools.length} pool${pools.length === 1 ? "" : "s"} open.` : "Staking isn't open yet." };
  },
});

export const PositionViewSchema = z.object({
  owner: z.string(),
  staked: z.string(),
  unstaking: z.string(),
  rewardEarned: z.string(),
  rewardPaid: z.string(),
  openedAt: nullableString,
  boostMultiplier: z.number(),
  nextBoost: z.object({ multiplier: z.number(), at: nullableString }).nullable(),
  walletBalance: z.string(),
  receiptBalance: z.string(),
  needsDeposit: z.boolean(),
  unstakes: z.array(z.object({ amount: z.string(), reward: z.string(), unlockAt: nullableString, status: z.string(), releaseTx: nullableString })),
  history: z.array(z.object({ kind: z.string(), amount: z.string(), at: nullableString, tx: nullableString })),
});

export const getStakingPosition = defineTool({
  name: "get_staking_position",
  title: "Staking position",
  description:
    "A wallet's staking position: staked, rewards earned so far, its boost and the next one, unstakes on their way back with their unlock times, wallet and receipt balances, and history. Defaults to the keystore's Solana wallet.",
  input: { owner: z.string().optional().describe("A Solana wallet. Default: the keystore's Solana wallet"), pool: PoolIdSchema },
  output: { pool: z.string(), symbol: z.string(), position: PositionViewSchema },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const owner = await ctx.defaultAddress("solana", a.owner);
    if (!isSolanaAddress(owner)) throw new RefusedError("invalid_input", `${owner} isn't a Solana address.`);
    const pool = await findPool(ctx, a.pool, signal);
    const p = await ctx.client.staking.position(pool.id, owner, { signal });
    const view = positionView(p, pool.decimals);
    return { data: { pool: pool.id, symbol: pool.symbol, position: view }, summary: `${view.staked} ${pool.symbol} staked, ${view.rewardEarned} earned so far.` };
  },
});

export const calcStakingEstimate = defineTool({
  name: "calc_staking_estimate",
  title: "Staking estimate",
  description:
    "What an amount would earn in a pool over a number of days at today's rate, stepping through the boosts as the stake ages, the way the staking server accrues. An estimate, not a promise: rates can change and payouts stop while the reward pool is empty.",
  input: {
    amount: z.string().regex(/^\d+(\.\d+)?$/).describe("Whole tokens, such as 25000"),
    days: z.number().int().min(1).max(3_650),
    pool: PoolIdSchema,
    aprBps: z.number().int().min(0).max(1_000_000).optional().describe("Use this rate instead of the pool's"),
    boosts: z.array(z.object({ days: z.number().int().min(0), multBps: z.number().int().min(10_000).max(1_000_000) })).max(20).optional(),
    decimals: z.number().int().min(0).max(18).optional().describe("With aprBps, the token's decimals. Default 6"),
  },
  output: { amount: z.string(), days: z.number(), estimatedReward: z.string(), effectiveAprPct: z.number(), aprPct: z.number(), source: z.enum(["pool", "input"]), note: z.string() },
  annotations: { ...PURE, openWorldHint: true },
  async run(a, { ctx, signal }) {
    let aprBps: number;
    let boosts: { days: number; multBps: number }[];
    let decimals: number;
    let source: "pool" | "input";
    if (a.aprBps !== undefined) {
      aprBps = a.aprBps;
      boosts = a.boosts ?? [];
      decimals = a.decimals ?? 6;
      source = "input";
    } else {
      const pool = await findPool(ctx, a.pool, signal);
      aprBps = pool.aprBps;
      boosts = a.boosts ?? pool.boosts;
      decimals = pool.decimals;
      source = "pool";
    }
    const raw = parseUnits(a.amount, decimals);
    const reward = estimateStakingReward(raw, aprBps, boosts, a.days);
    const eff = effectiveAprBps(aprBps, boosts, a.days);
    return {
      data: {
        amount: a.amount,
        days: a.days,
        estimatedReward: formatUnits(reward, decimals),
        effectiveAprPct: Number((eff / 100).toFixed(4)),
        aprPct: aprBps / 100,
        source,
        note: "Assumes today's rate and boosts hold for the whole period and the reward pool can pay. Not a promise of any return.",
      },
      summary: `About ${formatUnits(reward, decimals)} over ${a.days} days at today's rate, if nothing changes.`,
    };
  },
});

export const stakingTools = [getStakingPools, getStakingPosition, calcStakingEstimate];
