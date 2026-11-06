/**
 * Resource subscriptions. A client subscribed to `stealth://coin/{address}` is told the coin changed, through
 * `notifications/resources/updated`, and reads it again when it wants the new state:
 *
 * - a launchpad coin on Solana, from the live stream (its trades and state changes), falling back to polling when the stream can't open;
 * - an EVM coin, by polling its trades, since EVM chains have no stream;
 * - a staking pool, by re-reading it and comparing;
 * - the Feed (`stealth://feed`), when a new item lands on top;
 * - Trending (`stealth://trending`), when the top 20 change order or members.
 *
 * Updates are throttled per resource, so a busy coin can't flood a client.
 *
 * @module
 */
import { createHash } from "node:crypto";

import { pollTrades } from "@juststealthit/sdk/live";

import type { StealthContext } from "./context.js";
import { docPage } from "./docs/pages.js";
import { NotFoundError, RefusedError } from "./errors.js";
import { resolveCoin } from "./tools/coins.js";

export const THROTTLE_MS = 2_000;

export type ParsedUri =
  | { kind: "coin"; address: string }
  | { kind: "staking"; pool: string }
  | { kind: "docs"; page: string }
  | { kind: "feed" }
  | { kind: "trending" }
  | { kind: "static" };

export function parseStealthUri(uri: string): ParsedUri | null {
  const m = /^stealth:\/\/([a-z]+)(?:\/([^/?#]+))?$/.exec(uri);
  if (!m) return null;
  const [, kind, rest] = m;
  const value = rest ? decodeURIComponent(rest) : "";
  if (kind === "coin" && value) return { kind: "coin", address: value };
  if (kind === "staking" && value) return { kind: "staking", pool: value };
  if (kind === "docs" && value) return { kind: "docs", page: value };
  if (kind === "chains" && !value) return { kind: "static" };
  if (kind === "feed" && !value) return { kind: "feed" };
  if (kind === "trending" && !value) return { kind: "trending" };
  return null;
}

/** Calls `fn` at most once per `ms`, and once more after a burst ends. */
export function throttle(fn: () => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    last = Date.now();
    fn();
  };
  const wrapped = () => {
    const wait = last + ms - Date.now();
    if (wait <= 0 && !timer) run();
    else if (!timer) timer = setTimeout(run, Math.max(0, wait));
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** The most resources one session can watch at once. Each one is a stream listener or a poller. */
export const MAX_SUBSCRIPTIONS = 50;

export class Subscriptions {
  private readonly active = new Map<string, () => void>();
  /** Subscriptions still resolving their coin, so a second request, an unsubscribe or a close can't leak a watcher. */
  private readonly pending = new Map<string, { promise: Promise<void>; cancelled: boolean }>();
  private closed = false;

  constructor(
    private readonly ctx: StealthContext,
    private readonly notify: (uri: string) => Promise<void>,
    private readonly max = MAX_SUBSCRIPTIONS,
  ) {}

  get uris(): string[] {
    return [...this.active.keys()];
  }

  /** Starts watching `uri`. Throws for a resource that doesn't exist, or past the per-session cap. */
  async subscribe(uri: string): Promise<void> {
    if (this.closed) throw new RefusedError("closed", "This session is closing.");
    if (this.active.has(uri)) return;
    const inFlight = this.pending.get(uri);
    if (inFlight && !inFlight.cancelled) return inFlight.promise;
    const parsed = parseStealthUri(uri);
    if (!parsed) throw new Error(`Unknown resource ${uri}.`);
    if (this.active.size + this.pending.size >= this.max) {
      throw new RefusedError("too_many_subscriptions", `This session already watches ${this.max} resources. Unsubscribe from some first.`);
    }
    const entry = { promise: Promise.resolve(), cancelled: false };
    entry.promise = this.start(uri, parsed, entry).finally(() => {
      if (this.pending.get(uri) === entry) this.pending.delete(uri);
    });
    this.pending.set(uri, entry);
    return entry.promise;
  }

  private async start(uri: string, parsed: ParsedUri, entry: { cancelled: boolean }): Promise<void> {
    const send = throttle(() => {
      this.notify(uri).catch((e: unknown) => this.ctx.logger.debug("resource update not delivered", { uri, error: String(e) }));
    }, THROTTLE_MS);
    let stop: () => void = () => undefined;

    if (parsed.kind === "coin") {
      const coin = await resolveCoin(this.ctx, parsed.address);
      // unsubscribed or closed while the coin was being looked up: start nothing
      if (entry.cancelled || this.closed) return;
      if (coin.kind === "sol") stop = this.watchSolana(coin.address, send);
      else if (coin.kind === "evm") {
        const chain = this.ctx.client.evm.chain(coin.chain);
        stop = pollTrades((t) => chain.getTrades(t, undefined, { cache: false }), coin.address, () => send(), { intervalMs: this.ctx.evmPollMs, onError: (e) => this.ctx.logger.debug("evm poll failed", { error: String(e) }) });
      } else stop = this.poll(() => this.ctx.client.sol.market.coin(coin.address, coin.chain === "solana" ? {} : { chain: coin.chain }, { cache: false }), send, 30_000);
    } else if (parsed.kind === "feed") {
      // the newest item's id is enough: anything new goes on top
      stop = this.poll(async () => (await this.ctx.client.feed.list({ filter: "all", limit: 1 }, { cache: false })).items[0]?.id ?? null, send, this.ctx.feedPollMs);
    } else if (parsed.kind === "trending") {
      // the order of the top coins: a coin moving in, out or up is the news, not every price tick
      stop = this.poll(async () => (await this.ctx.client.market.trending({}, { cache: false })).coins.slice(0, 20).map((c) => `${c.chain}:${c.address}`), send, this.ctx.trendingPollMs);
    } else if (parsed.kind === "docs") {
      if (!docPage(parsed.page)) throw new NotFoundError(`No docs page "${parsed.page}".`);
    } else if (parsed.kind === "staking") {
      const pool = parsed.pool;
      stop = this.poll(async () => {
        const o = await this.ctx.client.staking.status({ cache: false });
        // opening counts as a change too
        return { state: o.state, pool: o.pools.find((p) => p.id === pool) ?? null };
      }, send, this.ctx.stakingPollMs);
    }
    // docs and the chain list never change while the server runs: a subscription to them is accepted and stays quiet

    this.active.set(uri, () => {
      send.cancel();
      stop();
    });
    this.ctx.logger.debug("subscribed", { uri });
  }

  unsubscribe(uri: string) {
    const p = this.pending.get(uri);
    if (p) {
      p.cancelled = true;
      this.pending.delete(uri);
    }
    this.active.get(uri)?.();
    this.active.delete(uri);
  }

  close() {
    this.closed = true;
    for (const p of this.pending.values()) p.cancelled = true;
    this.pending.clear();
    for (const off of this.active.values()) off();
    this.active.clear();
  }

  private watchSolana(mint: string, send: () => void): () => void {
    try {
      const live = this.ctx.client.live();
      const off = live.token(mint, () => send());
      // messages sent while the socket was down are gone: tell the client to read again
      const offReconnect = live.onReconnect(() => send());
      return () => {
        off();
        offReconnect();
      };
    } catch (error) {
      this.ctx.logger.info("live stream unavailable, polling instead", { error: error instanceof Error ? error.message : String(error) });
      const tokens = this.ctx.client.sol.tokens;
      return pollTrades((t) => tokens.trades(t, undefined, { cache: false }), mint, () => send(), { intervalMs: this.ctx.evmPollMs });
    }
  }

  /** Re-reads every `ms` and calls `send` when the answer changed. */
  private poll(read: () => Promise<unknown>, send: () => void, ms: number): () => void {
    let last: string | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const d = digest(await read());
        if (last !== null && d !== last) send();
        last = d;
      } catch (e) {
        this.ctx.logger.debug("resource poll failed", { error: String(e) });
      }
      if (!stopped) timer = setTimeout(tick, ms);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}
