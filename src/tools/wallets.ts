/**
 * Wallet analytics: a Solana wallet's profile, PnL on launchpad coins, trades, rewards, portfolio, and its hidden EVM wallet.
 *
 * @module
 */
import { weiToNumber } from "@juststealthit/sdk/api";
import { isSolanaAddress } from "@juststealthit/sdk/utils";
import { z } from "zod";

import { RefusedError, describeError } from "../errors.js";
import { iso, nullableNumber, nullableString, num, str } from "../format.js";
import { READ, defineTool } from "./define.js";
import { STAKING_NOT_OPEN, positionView } from "./staking.js";

const VIEWS = ["summary", "pnl", "trades", "rewards", "portfolio", "evm"] as const;

export const getWalletAnalytics = defineTool({
  name: "get_wallet_analytics",
  title: "Wallet analytics",
  description:
    "A Solana wallet's record on the launchpad. Views: summary (identity, leaderboard ranks, PnL by period, win rate and trading style), pnl (positions over a range), trades (newest first), rewards (holder rewards paid and owed), portfolio (launchpad holdings and launched coins), evm (its hidden EVM wallet's balances and positions on every EVM chain). Past results say nothing about future ones.",
  input: {
    address: z.string().trim().refine(isSolanaAddress, "a Solana wallet address").optional().describe("Default: the keystore's Solana wallet"),
    view: z.enum(VIEWS).default("summary"),
    range: z.enum(["1d", "7d", "30d", "all"]).default("30d").describe("For pnl"),
    limit: z.number().int().min(1).max(100).default(20).describe("Rows for pnl, trades, portfolio and evm"),
    token: z.string().optional().describe("For trades: only this coin"),
  },
  output: { address: z.string(), view: z.string(), data: z.looseObject({}), updatedAt: nullableString },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const address = await ctx.defaultAddress("solana", a.address);
    if (!isSolanaAddress(address)) throw new RefusedError("invalid_input", `${address} isn't a Solana address.`);
    const w = ctx.client.sol.wallets;
    const o = { signal };
    switch (a.view) {
      case "summary": {
        const [profile, pnl] = await Promise.all([w.analytics(address, false, o), w.pnl(address, "30d", o).catch(() => null)]);
        const g = profile.market;
        return {
          data: {
            address,
            view: a.view,
            data: {
              identity: profile.identity,
              leaderboards: profile.boards,
              periods: g.periods,
              stats: g.stats,
              totalProfitUsd: num(g.totalProfitUsd),
              unrealizedUsd: num(g.unrealizedUsd),
              analyticsStatus: g.status,
              style: profile.analysis?.style
                ? {
                    trades: profile.analysis.style.trades,
                    avgTradeUsd: profile.analysis.style.avgTradeUsd,
                    tradesPerDay: profile.analysis.style.tradesPerDay,
                    execution: profile.analysis.style.execution,
                    launchpads: profile.analysis.style.launchpads,
                  }
                : null,
              launchpad30d: pnl ? pnl.summary : null,
            },
            updatedAt: iso(g.updatedAt),
          },
        };
      }
      case "pnl": {
        const p = await w.pnl(address, a.range, o);
        return {
          data: {
            address,
            view: a.view,
            data: {
              range: p.range,
              summary: p.summary,
              positions: p.positions.slice(0, a.limit).map((x) => ({
                token: x.token,
                symbol: x.symbol,
                valueUsd: num(x.valueUsd),
                costBasisUsd: num(x.costBasisUsd),
                realizedUsd: num(x.realizedUsd),
                unrealizedUsd: num(x.unrealizedUsd),
                totalProfitUsd: num(x.totalProfitUsd),
                totalProfitPct: num(x.totalProfitPct),
                closed: x.closed,
                lastTradeAt: iso(x.lastTradeAt),
              })),
            },
            updatedAt: iso(p.updatedAt),
          },
        };
      }
      case "trades": {
        const page = await w.trades(address, { limit: a.limit, token: a.token }, o);
        return {
          data: {
            address,
            view: a.view,
            data: {
              trades: page.items.map((t) => ({
                time: iso(t.timestamp),
                token: t.token,
                symbol: t.symbol,
                side: t.side,
                kind: t.kind,
                valueUsd: num(t.valueUsd),
                // 18-decimal fixed point, so this is SOL
                solAmount: weiToNumber(t.ethWei),
                marketCapUsd: num(t.marketCapUsd),
                tx: t.txHash,
              })),
              nextCursor: page.nextCursor,
            },
            updatedAt: null,
          },
        };
      }
      case "rewards": {
        const r = await w.rewards(address, o);
        return { data: { address, view: a.view, data: { totalUsd: num(r.totalUsd), byAsset: r.byAsset, owed: r.owed, recent: r.recent.slice(0, a.limit) }, updatedAt: null } };
      }
      case "portfolio": {
        const p = await w.portfolio(address, o);
        return {
          data: {
            address,
            view: a.view,
            data: {
              solBalance: num(p.ethBalance),
              totals: p.totals,
              holdings: p.holdings.slice(0, a.limit).map((h) => ({
                address: h.token.address,
                symbol: h.token.symbol,
                balance: num(h.balance),
                valueUsd: num(h.valueUsd),
                pnlUsd: num(h.pnlUsd),
                pnlPct: num(h.pnlPct),
                url: ctx.links.coin(h.token.address),
              })),
              launched: p.launches.slice(0, a.limit).map((l) => ({ address: l.token.address, symbol: l.token.symbol, unclaimedSol: num(l.fees.unclaimedEth), claimedSol: num(l.fees.claimedEth) })),
            },
            updatedAt: null,
          },
        };
      }
      case "evm": {
        const [view, positions] = await Promise.all([ctx.client.evm.wallet(address, o), ctx.client.evm.positions(address, o).catch(() => [])]);
        return {
          data: {
            address,
            view: a.view,
            data: {
              exists: view.exists,
              hiddenWallet: str(view.address),
              note: "A hidden wallet is held by Just Stealth It for this Solana wallet, with the same address on every EVM chain.",
              chains: view.chains.map((c) => ({ chain: c.chain, native: c.native, balance: num(c.balance), usd: num(c.usd), tokens: c.tokens.slice(0, a.limit).map((t) => ({ address: t.address, symbol: t.symbol, balance: num(t.balance), valueUsd: num(t.valueUsd) })) })),
              positions: positions.slice(0, a.limit).map((p) => ({ chain: p.chain, token: p.token, symbol: p.symbol, valueUsd: num(p.valueUsd), totalProfitUsd: num(p.totalProfitUsd), closed: p.closed })),
            },
            updatedAt: null,
          },
        };
      }
    }
  },
});

const settled = async <T>(name: string, p: Promise<T>, missing: string[]): Promise<T | null> => {
  try {
    return await p;
  } catch (error) {
    missing.push(`${name}: ${describeError(error).message}`);
    return null;
  }
};

export const getWalletOverview = defineTool({
  name: "get_wallet_overview",
  title: "Wallet overview",
  description:
    "Everything one Solana wallet holds across the platform, in one call: its SOL, its launchpad holdings by value, the coins it launched with their unclaimed creator fees, its $STEALTH staking (or that staking isn't open yet), and its hidden EVM wallet's balances on every EVM chain. Start here for \"what do I have\"; get_wallet_analytics goes deeper into PnL, trades and rewards. Defaults to the keystore's Solana wallet. Values are at today's prices.",
  input: {
    address: z.string().trim().refine(isSolanaAddress, "a Solana wallet address").optional().describe("Default: config.json's wallet, else the keystore's Solana wallet"),
    limit: z.number().int().min(1).max(50).default(10).describe("Rows of holdings and launched coins"),
  },
  output: {
    address: z.string(),
    solBalance: nullableNumber,
    holdings: z
      .object({
        count: z.number(),
        valueUsd: nullableNumber,
        pnlUsd: nullableNumber,
        top: z.array(z.object({ address: z.string(), symbol: z.string(), balance: nullableNumber, valueUsd: nullableNumber, pnlUsd: nullableNumber, url: z.string() })),
      })
      .nullable(),
    launched: z
      .object({ count: z.number(), claimableSol: nullableNumber, top: z.array(z.object({ address: z.string(), symbol: z.string(), unclaimedSol: nullableNumber, claimedSol: nullableNumber, url: z.string() })) })
      .nullable(),
    staking: z
      .object({
        state: z.enum(["open", "not_open"]),
        pool: nullableString,
        staked: nullableString,
        unstaking: nullableString,
        rewardEarned: nullableString,
        receiptBalance: nullableString,
        message: nullableString,
      })
      .nullable(),
    evmWallet: z
      .object({
        exists: z.boolean(),
        address: nullableString,
        totalUsd: nullableNumber,
        chains: z.array(z.object({ chain: z.string(), native: z.string(), balance: nullableNumber, usd: nullableNumber, tokens: z.number() })),
      })
      .nullable(),
    unavailable: z.array(z.string()).describe("Parts that couldn't be read just now, and why. Missing parts are unknown, not empty"),
  },
  annotations: READ,
  async run(a, { ctx, signal }) {
    const address = await ctx.defaultAddress("solana", a.address);
    if (!isSolanaAddress(address)) throw new RefusedError("invalid_input", `${address} isn't a Solana address.`);
    const o = { signal };
    const missing: string[] = [];
    const [portfolio, staking, evm] = await Promise.all([
      settled("portfolio", ctx.client.sol.wallets.portfolio(address, o), missing),
      settled("staking", ctx.client.staking.status(o), missing),
      settled("EVM wallet", ctx.client.evm.wallet(address, o), missing),
    ]);
    const pool = staking?.state === "open" ? (staking.pools.find((p) => p.id === "stealth") ?? staking.pools[0] ?? null) : null;
    const position = pool ? await settled("staking position", ctx.client.staking.position(pool.id, address, o), missing) : null;
    const view = pool && position ? positionView(position, pool.decimals) : null;

    const holdings = portfolio
      ? {
          count: portfolio.holdings.length,
          valueUsd: num(portfolio.totals.holdingsUsd),
          pnlUsd: num(portfolio.totals.pnlUsd),
          top: [...portfolio.holdings]
            .sort((x, y) => (y.valueUsd ?? 0) - (x.valueUsd ?? 0))
            .slice(0, a.limit)
            .map((h) => ({ address: h.token.address, symbol: h.token.symbol, balance: num(h.balance), valueUsd: num(h.valueUsd), pnlUsd: num(h.pnlUsd), url: ctx.links.coin(h.token.address) })),
        }
      : null;
    const launched = portfolio
      ? {
          count: portfolio.launches.length,
          claimableSol: num(portfolio.totals.claimableEth),
          top: [...portfolio.launches]
            .sort((x, y) => (y.fees.unclaimedEth ?? 0) - (x.fees.unclaimedEth ?? 0))
            .slice(0, a.limit)
            .map((l) => ({ address: l.token.address, symbol: l.token.symbol, unclaimedSol: num(l.fees.unclaimedEth), claimedSol: num(l.fees.claimedEth), url: ctx.links.coin(l.token.address) })),
        }
      : null;
    const stakingView = staking
      ? {
          state: staking.state,
          pool: pool?.id ?? null,
          staked: view?.staked ?? null,
          unstaking: view?.unstaking ?? null,
          rewardEarned: view?.rewardEarned ?? null,
          receiptBalance: view?.receiptBalance ?? null,
          message: staking.state === "open" ? null : STAKING_NOT_OPEN,
        }
      : null;
    const evmWallet = evm
      ? {
          exists: evm.exists,
          address: str(evm.address),
          totalUsd: Number(evm.chains.reduce((n, c) => n + (c.usd ?? 0) + c.tokens.reduce((m, t) => m + (t.valueUsd ?? 0), 0), 0).toFixed(2)),
          chains: evm.chains.map((c) => ({ chain: c.chain, native: c.native, balance: num(c.balance), usd: num(c.usd), tokens: c.tokens.length })),
        }
      : null;
    const parts = [
      portfolio ? `${(num(portfolio.ethBalance) ?? 0).toFixed(4)} SOL` : null,
      holdings ? `${holdings.count} holding${holdings.count === 1 ? "" : "s"} worth $${(holdings.valueUsd ?? 0).toFixed(2)}` : null,
      launched?.count ? `${launched.count} coin${launched.count === 1 ? "" : "s"} launched` : null,
      stakingView ? (stakingView.state === "open" ? `${stakingView.staked ?? "0"} $STEALTH staked` : "staking not open yet") : null,
      evmWallet?.exists ? `EVM wallet $${(evmWallet.totalUsd ?? 0).toFixed(2)}` : null,
    ].filter(Boolean);
    return {
      data: { address, solBalance: portfolio ? num(portfolio.ethBalance) : null, holdings, launched, staking: stakingView, evmWallet, unavailable: missing },
      summary: `${address}: ${parts.join(", ") || "nothing could be read"}.${missing.length ? ` Unavailable: ${missing.length} part${missing.length === 1 ? "" : "s"}.` : ""}`,
    };
  },
});

export const walletTools = [getWalletOverview, getWalletAnalytics];
