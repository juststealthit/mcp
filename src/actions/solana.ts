/**
 * Builds Solana actions for a wallet to sign: trades on a coin's own venue or through Jupiter, $STEALTH staking, and launches. The API
 * builds each transaction; this module checks every one is paid by the wallet it was built for before handing it out.
 *
 * @module
 */
import type { SolanaLaunchInput } from "@juststealthit/sdk/solana";
import { decodeTransaction, feePayerOf } from "@juststealthit/sdk/solana";
import { StealthTransactionMismatchError } from "@juststealthit/sdk";

import type { StealthContext } from "../context.js";
import { RefusedError } from "../errors.js";
import type { EncodedSolanaTx } from "./prepared.js";

export const SOL_DECIMALS = 9;
export const PLATFORM_TOKEN_DECIMALS = 6;

/** Throws unless every transaction is paid by `owner`. */
export function assertPaidBy(txs: EncodedSolanaTx[], owner: string) {
  for (const t of txs) {
    const payer = feePayerOf(decodeTransaction(t.transaction));
    if (!payer || payer.toBase58() !== owner) throw new StealthTransactionMismatchError("The API's transaction isn't paid by this wallet, so it isn't returned.");
  }
}

export interface SolanaTradeQuote {
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  /** The rate right now: the tax, or the anti-sniper fee in a launch's first seconds. `null` on a Jupiter route. */
  feeBps: number | null;
  priceImpactPct: number | null;
}

export interface PreparedSolanaTrade {
  route: "app" | "jupiter";
  /** `curve` or `amm` on the app route; the AMMs Jupiter routes through otherwise. */
  venue: string;
  quote: SolanaTradeQuote;
  transactions: EncodedSolanaTx[];
  lastValidBlockHeight: number | null;
  tokenDecimals: number;
  symbol: string;
  name: string;
  onPlatform: boolean;
}

/** What a coin trades through, and its decimals. A coin the launchpad doesn't know is routed through Jupiter. */
export async function solanaRoute(ctx: StealthContext, mint: string, signal?: AbortSignal) {
  const token = await ctx.client.sol.tokens.find(mint, { signal });
  if (token) {
    const via = token.sol.swapVia;
    if (via === null) throw new RefusedError("not_tradable", token.sol.tradeMessage ?? `${token.symbol} can't be traded here right now.`);
    return { route: via, decimals: token.decimals ?? PLATFORM_TOKEN_DECIMALS, symbol: token.symbol, name: token.name, onPlatform: true };
  }
  const coin = await ctx.client.sol.market.coin(mint, {}, { signal });
  if (coin.decimals === null) throw new RefusedError("unknown_decimals", `The decimals of ${coin.symbol || mint} aren't known, so an amount can't be converted safely.`);
  return { route: "jupiter" as const, decimals: coin.decimals, symbol: coin.symbol, name: coin.name, onPlatform: coin.onPlatform };
}

/**
 * A buy or sell for `owner` to sign. `amount` is lamports on a buy and the token's base units on a sell.
 */
export async function prepareSolanaTrade(
  ctx: StealthContext,
  o: { mint: string; side: "buy" | "sell"; owner: string; amount: bigint; slippageBps: number; route?: Awaited<ReturnType<typeof solanaRoute>> },
  signal?: AbortSignal,
): Promise<PreparedSolanaTrade> {
  const r = o.route ?? (await solanaRoute(ctx, o.mint, signal));
  if (r.route === "app") {
    const built = await ctx.solana(o.owner).buildSwap({ mint: o.mint, side: o.side, amount: o.amount, slippageBps: o.slippageBps });
    const txs: EncodedSolanaTx[] = [{ transaction: built.transaction, version: "v0" }];
    assertPaidBy(txs, o.owner);
    return {
      route: "app",
      venue: built.quote.venue,
      quote: {
        amountIn: built.quote.amountIn,
        amountOut: built.quote.amountOut,
        minAmountOut: built.quote.minAmountOut,
        feeBps: built.quote.feeBps,
        priceImpactPct: built.quote.priceImpactPct,
      },
      transactions: txs,
      lastValidBlockHeight: built.lastValidBlockHeight ?? null,
      tokenDecimals: r.decimals,
      symbol: r.symbol,
      name: r.name,
      onPlatform: r.onPlatform,
    };
  }
  const built = await ctx.client.sol.market.buildSwap({ mint: o.mint, owner: o.owner, side: o.side, amount: o.amount, slippageBps: o.slippageBps }, { signal });
  if (BigInt(built.quote.minAmountOut) <= 0n) throw new StealthTransactionMismatchError("The swap would accept nothing back, so it isn't returned.");
  // Jupiter builds legacy or v0; the wire format says which
  const version = "version" in decodeTransaction(built.transaction) ? "v0" : "legacy";
  const txs: EncodedSolanaTx[] = [{ transaction: built.transaction, version }];
  assertPaidBy(txs, o.owner);
  return {
    route: "jupiter",
    venue: built.quote.route.join(" → ") || "Jupiter",
    quote: { amountIn: built.quote.amountIn, amountOut: built.quote.amountOut, minAmountOut: built.quote.minAmountOut, feeBps: null, priceImpactPct: built.quote.priceImpactPct },
    transactions: txs,
    lastValidBlockHeight: built.lastValidBlockHeight,
    tokenDecimals: r.decimals,
    symbol: r.symbol,
    name: r.name,
    onPlatform: r.onPlatform,
  };
}

/** The token balance of `owner` in base units, for selling a percentage. */
export async function solanaTokenBalance(ctx: StealthContext, owner: string, mint: string, signal?: AbortSignal): Promise<bigint> {
  const b = await ctx.client.sol.balance(owner, mint, { signal, cache: false });
  return BigInt(b.tokenBaseUnits ?? "0");
}

export async function prepareSolanaLaunch(ctx: StealthContext, owner: string, input: SolanaLaunchInput) {
  const prepared = await ctx.solana(owner).prepareLaunch(input);
  const txs: EncodedSolanaTx[] = [{ transaction: prepared.transaction, version: prepared.version }, ...(prepared.followUps ?? [])];
  assertPaidBy(txs, owner);
  return { prepared, transactions: txs };
}
