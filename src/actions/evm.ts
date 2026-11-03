/**
 * Builds EVM transactions for a wallet to sign: trades through the chain's `StealthRouter` and launches through `StealthFactory`,
 * direct on chain with no API in between. Quotes come from the chain's own quoter at the moment of preparing.
 *
 * Nothing here holds a key. Every transaction is returned unsigned, with any ERC-20 approval it needs first.
 *
 * @module
 */
import { StealthFeeTooHighError } from "@juststealthit/sdk";
import { abisFor, type EvmLaunchInput, type StealthEvm } from "@juststealthit/sdk/evm";
import { minOut } from "@juststealthit/sdk/math";
import { encodeFunctionData, erc20Abi, zeroAddress, type Address, type Hex } from "viem";

import type { EvmChain } from "../config.js";
import type { StealthContext } from "../context.js";

export const EVM_DECIMALS = 18;

export interface UnsignedEvmTx {
  /** What this step does. */
  label: string;
  chainId: number;
  from: Address;
  to: Address;
  data: Hex;
  /** Wei, as a decimal string. */
  value: string;
}

const approveTx = (evm: StealthEvm, from: Address, token: Address, spender: Address, amount: bigint, label: string): UnsignedEvmTx => ({
  label,
  chainId: evm.deployment.chainId,
  from,
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  value: "0",
});

export interface PreparedEvmTrade {
  transactions: UnsignedEvmTx[];
  quote: { amountIn: string; amountOut: string; minAmountOut: string; feeBps: number };
  /** Unix seconds after which the swap reverts. */
  deadline: number;
  router: Address;
}

/** A buy (spend exactly `amount` of the quote) or a sell (sell exactly `amount` tokens), for `from` to sign. */
export async function prepareEvmTrade(
  ctx: StealthContext,
  o: { chain: EvmChain; token: Address; side: "buy" | "sell"; from: Address; amount: bigint; slippageBps: number; maxFeeBps: number; deadlineSec?: number },
): Promise<PreparedEvmTrade> {
  const evm = ctx.evm(o.chain);
  const q = o.side === "buy" ? await evm.quoteBuy(o.token, o.amount) : await evm.quoteSell(o.token, o.amount);
  if (q.feeBps > o.maxFeeBps) throw new StealthFeeTooHighError(q.feeBps, o.maxFeeBps);
  const limit = minOut(q.amountOut, o.slippageBps);
  const [key, block] = await Promise.all([evm.getPoolKey(o.token), evm.publicClient.getBlock({ blockTag: "latest" })]);
  const deadline = block.timestamp + BigInt(o.deadlineSec ?? 600);
  const router = evm.deployment.router;
  const native = q.currencyIn === zeroAddress;
  const txs: UnsignedEvmTx[] = [];
  if (!native) {
    const allowed = await evm.publicClient.readContract({ address: q.currencyIn, abi: erc20Abi, functionName: "allowance", args: [o.from, router] });
    if (allowed < q.amountIn) txs.push(approveTx(evm, o.from, q.currencyIn, router, q.amountIn, `Approve the router to spend ${q.amountIn} base units`));
  }
  const data = encodeFunctionData({
    abi: abisFor(evm.deployment.dex).stealthRouterAbi,
    functionName: "swap",
    args: [{ key, zeroForOne: o.side === "buy", exactInput: true, amount: q.amountIn, limit, recipient: o.from, usePermit2: false, deadline }],
  } as never);
  txs.push({ label: o.side === "buy" ? "Buy" : "Sell", chainId: evm.deployment.chainId, from: o.from, to: router, data, value: (native ? q.amountIn : 0n).toString() });
  return {
    transactions: txs,
    quote: { amountIn: q.amountIn.toString(), amountOut: q.amountOut.toString(), minAmountOut: limit.toString(), feeBps: q.feeBps },
    deadline: Number(deadline),
    router,
  };
}

/** The token balance of `owner`, in raw units, for selling a percentage. */
export async function evmTokenBalance(ctx: StealthContext, chain: EvmChain, token: Address, owner: Address): Promise<bigint> {
  return ctx.evm(chain).publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

/** A launch for `from` to sign: token, pool and first buy in one transaction, after an approval on an ERC-20 pair. */
export async function prepareEvmLaunch(ctx: StealthContext, chain: EvmChain, from: Address, input: EvmLaunchInput) {
  const evm = ctx.evm(chain);
  const prepared = await evm.prepareLaunch(input, from);
  const txs: UnsignedEvmTx[] = [];
  if (prepared.approval) txs.push(approveTx(evm, from, prepared.approval.token, prepared.approval.spender, prepared.approval.amount, "Approve the factory to take the first buy"));
  txs.push({
    label: "Launch",
    chainId: evm.deployment.chainId,
    from,
    to: evm.deployment.factory,
    data: encodeFunctionData({ abi: abisFor(evm.deployment.dex).stealthFactoryAbi, functionName: "launch", args: [prepared.params] } as never),
    value: prepared.value.toString(),
  });
  return { prepared, transactions: txs };
}
