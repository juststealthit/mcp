/**
 * What every session of the server shares: the read client and its cache, the perps client, the live stream, per-chain EVM clients,
 * prepared actions and, when it's on, the local signer. One context serves any number of MCP sessions (stdio has one, HTTP many).
 *
 * @module
 */
import { MemoryCache, createStealthClient, type ApiOptions, type StealthClient } from "@juststealthit/sdk";
import { createStealthEvm, EVM_DEPLOYMENTS, type StealthEvm } from "@juststealthit/sdk/evm";
import type { WebSocketConstructor } from "@juststealthit/sdk/live";
import { createPerpsClient, type PerpsClient } from "@juststealthit/sdk/perps";
import { createStealthSolana, type SolanaSigner, type StealthSolana } from "@juststealthit/sdk/solana";
import { PublicKey } from "@solana/web3.js";

import { PreparedStore } from "./actions/prepared.js";
import type { LocalSigner } from "./actions/signing.js";
import type { EvmChain, ResolvedConfig } from "./config.js";
import { RefusedError } from "./errors.js";
import { readKeystore, type KeystoreWallet } from "./keystore.js";
import { Links } from "./links.js";
import { Logger } from "./logger.js";
import { SERVER_NAME, VERSION } from "./version.js";

export interface StealthContextOptions {
  config: ResolvedConfig;
  /** The shared config directory, for the keystore and the spend ledger. */
  configDir: string;
  logger?: Logger;
  /** Per try, in ms. Default 15 s. */
  timeoutMs?: number;
  /** TTL for cached API reads, in ms. `0` turns the cache off. Default 5 s. */
  cacheTtlMs?: number;
  /** RPC URLs for EVM reads, per chain. Default: each chain's public RPC. */
  rpcUrls?: Partial<Record<EvmChain, string>>;
  /** A WebSocket constructor for the live stream, where the runtime has none (Node 20). */
  WebSocket?: WebSocketConstructor;
  /** Your own `fetch`, for proxies and tests. */
  fetch?: typeof globalThis.fetch;
  /** The site the links point at. Default: derived from `apiUrl`. */
  siteUrl?: string;
  /** How often EVM coins are polled for resource updates, in ms. Default 15 s. */
  evmPollMs?: number;
  /** How often a subscribed staking pool is re-read, in ms. Default 60 s. */
  stakingPollMs?: number;
  /** How often a subscribed Feed or Trending list is re-read, in ms. Default 15 s and 60 s. */
  feedPollMs?: number;
  trendingPollMs?: number;
  /** The local signer, when signing is on. */
  signer?: LocalSigner | null;
  /** Why signing is off, for the status tool. */
  signingOffReason?: string;
}

export class StealthContext {
  readonly config: ResolvedConfig;
  readonly configDir: string;
  readonly logger: Logger;
  readonly client: StealthClient;
  readonly perps: PerpsClient;
  readonly links: Links;
  readonly prepared = new PreparedStore();
  readonly signer: LocalSigner | null;
  readonly signingOffReason: string | undefined;
  readonly evmPollMs: number;
  readonly stakingPollMs: number;
  readonly feedPollMs: number;
  readonly trendingPollMs: number;
  private readonly apiOptions: ApiOptions;
  private readonly rpcUrls: Partial<Record<EvmChain, string>>;
  private readonly evmClients = new Map<EvmChain, StealthEvm>();
  private keystoreWallets: Promise<KeystoreWallet[]> | null = null;
  private closed = false;

  constructor(opts: StealthContextOptions) {
    this.config = opts.config;
    this.configDir = opts.configDir;
    this.logger = opts.logger ?? new Logger();
    this.signer = opts.signer ?? null;
    this.signingOffReason = opts.signingOffReason;
    this.evmPollMs = opts.evmPollMs ?? 15_000;
    this.stakingPollMs = opts.stakingPollMs ?? 60_000;
    this.feedPollMs = opts.feedPollMs ?? 15_000;
    this.trendingPollMs = opts.trendingPollMs ?? 60_000;
    this.rpcUrls = opts.rpcUrls ?? {};
    this.links = new Links(opts.config.apiUrl, opts.siteUrl);
    const headers: Record<string, string> = { "user-agent": `${SERVER_NAME}/${VERSION}` };
    if (opts.config.apiKey) headers["x-api-key"] = opts.config.apiKey;
    const ttl = opts.cacheTtlMs ?? 5_000;
    this.apiOptions = {
      apiUrl: opts.config.apiUrl,
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs ?? 15_000,
      retry: 2,
      headers,
      onResponse: (e) => {
        if (e.error) this.logger.debug("api request failed", { method: e.method, url: e.url, attempt: e.attempt, requestId: e.requestId });
        else if (!e.cached) this.logger.debug("api", { method: e.method, url: e.url, status: e.status, ms: e.durationMs });
      },
    };
    this.client = createStealthClient({
      ...this.apiOptions,
      cache: ttl > 0 ? new MemoryCache({ ttlMs: ttl, maxEntries: 2_000 }) : false,
      stream: { WebSocket: opts.WebSocket },
    });
    this.perps = createPerpsClient({ fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? 15_000, WebSocket: opts.WebSocket });
  }

  /** A Solana client for building transactions. Without a signer it is watch-only: it can prepare for `owner`, never sign. */
  solana(owner: string, signer?: SolanaSigner): StealthSolana {
    return createStealthSolana({ ...this.apiOptions, signer: signer ?? watchOnlySigner(owner), confirmTimeoutMs: 60_000 });
  }

  /** One EVM chain's direct client, for quotes and calldata. Never holds a key. */
  evm(chain: EvmChain): StealthEvm {
    let c = this.evmClients.get(chain);
    if (!c) {
      const env = process.env[`STEALTH_RPC_${chain.toUpperCase()}`];
      c = createStealthEvm({ chain, rpcUrl: this.rpcUrls[chain] ?? env ?? EVM_DEPLOYMENTS[chain].rpcUrl });
      this.evmClients.set(chain, c);
    }
    return c;
  }

  /** Wallets in the shared keystore: names, kinds and public addresses. Read once, without the passphrase. */
  async wallets(): Promise<KeystoreWallet[]> {
    this.keystoreWallets ??= readKeystore(this.configDir)
      .then((k) => {
        for (const w of k.warnings) this.logger.warn(w);
        return k.wallets;
      })
      .catch(() => []);
    return this.keystoreWallets;
  }

  /**
   * The wallet a prepared action is for: the one given, else the signer's, else config.json's default wallet when it is of that kind
   * (the CLI's `wallet` setting), else the keystore's first of that kind.
   */
  async defaultAddress(kind: "solana" | "evm", given?: string): Promise<string> {
    if (given) return given;
    if (kind === "solana" && this.signer) return this.signer.address;
    const all = await this.wallets();
    const w = all.find((x) => x.kind === kind && x.name === this.config.wallet) ?? all.find((x) => x.kind === kind);
    if (w) return w.address;
    throw new RefusedError("owner_required", `Say which ${kind === "solana" ? "Solana" : "EVM"} wallet this is for: pass its address, or add one to the shared keystore.`);
  }

  private readonly memos = new Map<string, { at: number; value: Promise<unknown> }>();

  /** Caches `fn`'s answer for `ttlMs`, for reads outside the API client's own cache (perps venues, pool lists). Failures aren't kept. */
  memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.memos.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = fn().catch((e: unknown) => {
      this.memos.delete(key);
      throw e;
    });
    this.memos.set(key, { at: Date.now(), value });
    if (this.memos.size > 200) this.memos.delete(this.memos.keys().next().value!);
    return value;
  }

  /** Closes the live stream and drops cached clients. Safe to call twice. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.client.close();
    this.prepared.clear();
    this.memos.clear();
  }
}

/** A signer that knows its address and refuses to sign: what prepare-only mode builds with. */
export function watchOnlySigner(owner: string): SolanaSigner {
  let publicKey: PublicKey;
  try {
    publicKey = new PublicKey(owner);
  } catch {
    throw new RefusedError("invalid_input", `${owner} isn't a Solana address.`);
  }
  return {
    publicKey,
    signTransaction: async () => {
      throw new RefusedError("signing_disabled", "This server prepares transactions only. Sign them in your own wallet.");
    },
  };
}
