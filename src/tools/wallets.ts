/**
 * Wallet analytics: a Solana wallet's profile, PnL on launchpad coins, trades, rewards, portfolio, and its hidden EVM wallet.
 *
 * @module
 */
import { weiToNumber } from "@juststealthit/sdk/api";
import { isSolanaAddress } from "@juststealthit/sdk/utils";
import { z } from "zod";

import { RefusedError } from "../errors.js";
import { iso, nullableString, num, str } from "../format.js";
import { READ, defineTool } from "./define.js";

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
        const g = profile.gmgn;
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

export const walletTools = [getWalletAnalytics];
