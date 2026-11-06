/**
 * Local signing, off by default. When the user turns it on, a prepared Solana action can be signed with a wallet from the shared
 * keystore and sent, after these checks, in this order:
 *
 *  1. the prepared action exists, hasn't expired, and was prepared for this signer's wallet;
 *  2. every transaction in it is paid by this wallet (the SDK refuses anything else as well);
 *  3. a trade's quoted fee is within the fee limit the user accepted;
 *  4. its SOL spend is within the per-transaction cap, and the rolling 24-hour cap, reserved in the spend ledger;
 *  5. the user confirms in the client, through elicitation, where the client supports it.
 *
 * Caps are in SOL, so only Solana actions are signed here. EVM transactions are always returned unsigned.
 *
 * @module
 */
import { decodeTransaction, encodeTransaction, feePayerOf, keypairSigner } from "@juststealthit/sdk/solana";
import { formatUnits } from "@juststealthit/sdk/utils";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Keypair } from "@solana/web3.js";

import type { StealthContext } from "../context.js";
import { RefusedError } from "../errors.js";
import type { KeystoreWallet } from "../keystore.js";
import { DailyCapError, type SpendLedger } from "./ledger.js";
import type { PreparedAction } from "./prepared.js";

export interface SigningCaps {
  maxSolPerTx: number;
  maxSolPerDay: number;
}

export interface LocalSignerOptions {
  wallet: KeystoreWallet;
  keypair: Keypair;
  caps: SigningCaps;
  ledger: SpendLedger;
  /** Refuse to sign for a client that can't show a confirmation. Default false: such a client's own tool approval is relied on. */
  requireElicitation?: boolean;
}

export type Confirmation = "accepted" | "declined" | "cancelled" | "not_supported";

export interface SendResult {
  signatures: string[];
  status: "confirmed" | "sent";
  explorer: (string | null)[];
}

/**
 * Whether the client can show the confirmation form. The confirmation is a form; a client that offers only URL elicitation can't
 * show it. An empty `elicitation: {}` means form support, as the spec keeps it for older clients.
 */
export function canConfirm(server: Server): boolean {
  const e = server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
  if (!e) return false;
  return Object.keys(e).length === 0 || !!e.form;
}

const LAMPORTS_PER_SOL = 1_000_000_000;
export const solToLamports = (sol: number) => BigInt(Math.round(sol * LAMPORTS_PER_SOL));
export const lamportsToSolText = (l: bigint) => formatUnits(l, 9);

export class LocalSigner {
  readonly address: string;
  readonly walletName: string;
  readonly caps: SigningCaps;
  readonly requireElicitation: boolean;
  private readonly keypair: Keypair;
  private readonly ledger: SpendLedger;

  constructor(opts: LocalSignerOptions) {
    if (opts.wallet.kind !== "solana") throw new RefusedError("unsupported_wallet", "Local signing supports Solana wallets only.");
    if (opts.keypair.publicKey.toBase58() !== opts.wallet.address) throw new RefusedError("address_mismatch", "The unlocked key doesn't match the wallet.");
    this.address = opts.wallet.address;
    this.walletName = opts.wallet.name;
    this.caps = opts.caps;
    this.requireElicitation = opts.requireElicitation ?? false;
    this.keypair = opts.keypair;
    this.ledger = opts.ledger;
  }

  get maxPerTxLamports() {
    return solToLamports(this.caps.maxSolPerTx);
  }
  get maxPerDayLamports() {
    return solToLamports(this.caps.maxSolPerDay);
  }

  async spentLastDay(): Promise<bigint> {
    return this.ledger.spentLastDay();
  }

  /** The checks that need no network and no user: wallet, payer, fee limit, per-transaction cap. */
  check(action: PreparedAction) {
    if (action.owner !== this.address) {
      throw new RefusedError("wrong_wallet", `This action was prepared for ${action.owner}, but the signing wallet is ${this.address}. Prepare it again for the signing wallet.`);
    }
    if (action.transactions.length === 0) throw new RefusedError("nothing_to_sign", "The prepared action holds no transaction.");
    for (const t of action.transactions) {
      const payer = feePayerOf(decodeTransaction(t.transaction));
      if (!payer || payer.toBase58() !== this.address) throw new RefusedError("transaction_mismatch", "A prepared transaction isn't paid by the signing wallet, so it won't be signed.");
    }
    if (action.feeBps !== null && action.maxFeeBps !== null && action.feeBps > action.maxFeeBps) {
      throw new RefusedError("fee_too_high", `This trade pays ${action.feeBps / 100}% right now, above the ${action.maxFeeBps / 100}% limit.`, { feeBps: action.feeBps, maxFeeBps: action.maxFeeBps });
    }
    if (action.spendLamports > this.maxPerTxLamports) {
      throw new RefusedError("over_tx_cap", `This spends ${lamportsToSolText(action.spendLamports)} SOL, above the ${this.caps.maxSolPerTx} SOL per-transaction cap set in config.json (mcp.maxSolPerTx).`, {
        spendSol: lamportsToSolText(action.spendLamports),
        maxSolPerTx: this.caps.maxSolPerTx,
      });
    }
  }

  /** Asks the user to confirm through the client. */
  async confirm(server: Server, action: PreparedAction, signal?: AbortSignal): Promise<Confirmation> {
    if (!canConfirm(server)) return "not_supported";
    const result = await server.elicitInput(
      {
        mode: "form",
        message: `Sign and send with wallet "${this.walletName}" (${this.address})?\n\n${action.summary}\n\nThis can't be undone. It is your own decision; nothing here is advice or a promise of any return.`,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: { type: "boolean", title: "Sign and send this transaction", description: "Tick to sign with your local wallet and send it now.", default: false },
          },
          required: ["confirm"],
        },
      },
      { signal, timeout: 300_000 },
    );
    if (result.action === "accept") return result.content?.confirm === true ? "accepted" : "declined";
    return result.action === "decline" ? "declined" : "cancelled";
  }

  /** Reserves the spend under the daily cap, signs, sends and settles the ledger. */
  async execute(ctx: StealthContext, action: PreparedAction): Promise<SendResult> {
    let reservation: string;
    try {
      reservation = await this.ledger.reserve(action.spendLamports, action.kind, this.maxPerDayLamports);
    } catch (error) {
      if (error instanceof DailyCapError) {
        throw new RefusedError("over_daily_cap", `This would go over the ${this.caps.maxSolPerDay} SOL daily cap set in config.json (mcp.maxSolPerDay). ${lamportsToSolText(error.leftLamports)} SOL is left in the last 24 hours.`, {
          spentSol: lamportsToSolText(error.spentLamports),
          leftSol: lamportsToSolText(error.leftLamports),
        });
      }
      throw error;
    }
    let sent = false;
    try {
      const signer = keypairSigner(this.keypair);
      if (action.stakingActionId !== null) {
        const tx = decodeTransaction(action.transactions[0]!.transaction);
        // co-signed by the staking wallet: signed exactly as it came, never rebuilt
        const signed = await signer.signTransaction(tx);
        sent = true;
        const r = await ctx.client.staking.submit(action.stakingActionId, encodeTransaction(signed), { retry: false });
        await this.ledger.settle(reservation, r.status === "confirmed" ? "confirmed" : "sent", r.signature);
        return { signatures: [r.signature], status: r.status, explorer: [ctx.links.tx("solana", r.signature)] };
      }
      const sol = ctx.solana(this.address, {
        ...signer,
        // the reservation counts from the moment anything may have left this process
        signTransaction: async (tx) => {
          const out = await signer.signTransaction(tx);
          sent = true;
          return out;
        },
        signAllTransactions: async (txs) => {
          const out = await signer.signAllTransactions!(txs);
          sent = true;
          return out;
        },
      });
      const signatures = await sol.submit(action.transactions, { bundle: action.bundle });
      await this.ledger.settle(reservation, "confirmed", signatures[0] ?? null);
      return { signatures, status: "confirmed", explorer: signatures.map((s) => ctx.links.tx("solana", s)) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      const definitelyNotLanded = !sent || code === "transaction_failed" || code === "bundle_rejected" || code === "bundle_expired" || (error as { status?: number }).status === 400;
      await this.ledger.settle(reservation, definitelyNotLanded ? "failed" : "sent", (error as { signature?: string }).signature ?? null).catch(() => undefined);
      throw error;
    }
  }
}
