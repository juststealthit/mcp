/**
 * Prepared actions, held in memory until they're signed or they expire. A Solana transaction carries a recent blockhash and lapses in
 * about a minute, so a prepared action lives only as long: an old one is refused and prepared again, never signed stale.
 *
 * An action can be taken once. Taking it removes it, so a retry can't send the same transaction twice.
 *
 * @module
 */
import { randomBytes } from "node:crypto";

export type ActionKind = "buy" | "sell" | "stake" | "unstake" | "launch";

export interface EncodedSolanaTx {
  /** Base64 wire format. */
  transaction: string;
  version: "legacy" | "v0";
}

export interface PreparedAction {
  id: string;
  kind: ActionKind;
  chain: "solana";
  /** The wallet that pays and signs. */
  owner: string;
  /** Unix ms. */
  createdAt: number;
  expiresAt: number;
  /** What the user is asked to confirm. */
  summary: string;
  /** SOL this action spends, by intent: the buy, the first buy, a staking deposit. Network fees and rent aren't counted. */
  spendLamports: bigint;
  /** The fee rate quoted for a trade, in bps. */
  feeBps: number | null;
  /** The highest fee rate the user accepted, in bps. */
  maxFeeBps: number | null;
  transactions: EncodedSolanaTx[];
  /** Send as one Jito bundle. */
  bundle: boolean;
  /** A staking action is submitted through the staking API by its id. */
  stakingActionId: number | null;
  /** The coin. */
  mint: string | null;
  /** The site page to show with the result: the coin's page, or the home page for staking. */
  page: string | null;
}

export const PREPARED_TTL_MS = 75_000;
const MAX_ENTRIES = 200;

export class PreparedStore {
  private readonly items = new Map<string, PreparedAction>();

  constructor(
    private readonly ttlMs = PREPARED_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Stores an action and returns it with its id and expiry set. */
  put(action: Omit<PreparedAction, "id" | "createdAt" | "expiresAt">): PreparedAction {
    this.sweep();
    while (this.items.size >= MAX_ENTRIES) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    const createdAt = this.now();
    const full: PreparedAction = { ...action, id: `prep_${randomBytes(9).toString("base64url")}`, createdAt, expiresAt: createdAt + this.ttlMs };
    this.items.set(full.id, full);
    return full;
  }

  /** The action, without taking it. `null` if unknown or expired. */
  peek(id: string): PreparedAction | null {
    const a = this.items.get(id);
    if (!a) return null;
    if (a.expiresAt <= this.now()) {
      this.items.delete(id);
      return null;
    }
    return a;
  }

  /** Takes the action out, so it can be used once. */
  take(id: string): PreparedAction | null {
    const a = this.peek(id);
    if (a) this.items.delete(id);
    return a;
  }

  /** Whether `id` was ever issued and has lapsed, for a clearer error. */
  isExpired(id: string): boolean {
    const a = this.items.get(id);
    return !!a && a.expiresAt <= this.now();
  }

  sweep() {
    const t = this.now();
    for (const [id, a] of this.items) if (a.expiresAt <= t) this.items.delete(id);
  }

  get size() {
    return this.items.size;
  }

  clear() {
    this.items.clear();
  }
}
