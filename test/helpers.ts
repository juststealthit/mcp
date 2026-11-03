import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ClientCapabilities, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

import { SpendLedger } from "../src/actions/ledger.js";
import { LocalSigner } from "../src/actions/signing.js";
import { resolveConfig, type ConfigFile } from "../src/config.js";
import { StealthContext, type StealthContextOptions } from "../src/context.js";
import { encryptSecret, type KeystoreWallet } from "../src/keystore.js";
import { Logger } from "../src/logger.js";
import { createStealthServer } from "../src/server.js";

export interface Call {
  method: string;
  url: URL;
  /** `/path?query`, without the API's `/api` prefix. */
  path: string;
  body: unknown;
  headers: Headers;
}

type Reply = unknown | ((call: Call) => unknown);
export const reply = (status: number, body: unknown) => ({ __reply: true, status, body });

/**
 * A stand-in for every HTTP endpoint the server reads, over `fetch`. Routes are `METHOD /path` for the platform API, or
 * `METHOD https://host/path` for anything else. Unknown routes answer 404, and every call is kept.
 */
export function fakeApi(routes: Record<string, Reply>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const local = url.pathname.replace(/^\/api/, "");
    const call: Call = { method, url, path: local + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) };
    calls.push(call);
    const isApi = url.origin === "https://juststealthit.xyz";
    const route = isApi ? (routes[`${method} ${local}${url.search}`] ?? routes[`${method} ${local}`]) : routes[`${method} ${url.origin}${url.pathname}`];
    if (route === undefined) return new Response(JSON.stringify({ error: "not_found", message: `no route for ${method} ${url.href}` }), { status: 404 });
    const out = typeof route === "function" ? (route as (c: Call) => unknown)(call) : route;
    const r = (out && typeof out === "object" && "__reply" in out ? out : { status: 200, body: out }) as { status: number; body: unknown };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const BLOCKHASH = "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W";

/** An unsigned v0 transfer paid by `payer`, as a swap comes back from the API. */
export function swapTx(payer: PublicKey, lamports = 1_000n) {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

/** A legacy transaction paid by `payer` and already signed by `cosigner`, as a staking action comes back. */
export function cosignedLegacyTx(payer: PublicKey, cosigner: Keypair) {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH }).add(SystemProgram.transfer({ fromPubkey: cosigner.publicKey, toPubkey: payer, lamports: 1 }));
  tx.partialSign(cosigner);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

export const MINT = "So11111111111111111111111111111111111111112";

/** A launchpad coin on Solana, as `/sol/tokens/:mint` answers. */
export function solToken(over: Record<string, unknown> = {}, sol: Record<string, unknown> = {}) {
  return {
    address: MINT,
    launcher: "11111111111111111111111111111111",
    creator: "11111111111111111111111111111111",
    feeRecipient: "11111111111111111111111111111111",
    name: "Test Coin",
    symbol: "TEST",
    description: "",
    logoUrl: null,
    socials: {},
    createdAt: Date.now() - 3_600_000,
    launchBlock: 1,
    decimals: 6,
    totalSupply: 1_000_000_000,
    taxBps: 225,
    sniperWindowSec: 15,
    sniperTaxBps: 9_000,
    poolId: "pool",
    status: "new",
    priceEth: 0.00000003,
    priceUsd: 0.000005,
    marketCapUsd: 5_000,
    liquidityUsd: 4_000,
    volume24hUsd: 12_000,
    txns24h: { buys: 40, sells: 12 },
    holders: 77,
    change: { m5: 1, h1: 5, h24: 20 },
    graduation: { raisedEth: 21.25, targetEth: 85, chosenTargetEth: 85, progress: 0.25, migrated: false, migratedAt: null, migratedTx: null },
    lastTradeAt: Date.now(),
    sol: {
      chain: "solana",
      network: "mainnet",
      kind: "meteora",
      venue: "meteora",
      taxTier: "m180",
      globalTaxBps: 0,
      pool: "pool",
      ammPool: null,
      escrow: "escrow",
      recipientKind: "wallet",
      recipientWallet: null,
      social: null,
      poolFeeBps: 225,
      launchSig: null,
      external: false,
      official: false,
      onchainSymbol: "TEST",
      tradable: true,
      tradeReason: null,
      tradeMessage: null,
      quoteMint: null,
      quoteSymbol: "SOL",
      swapVia: "app",
      pair: null,
      feeMode: "holders",
      feeShares: { creatorBps: 10_000, marketingBps: 0 },
      feePlan: null,
      ...sol,
    },
    pool: { poolId: "pool", currency0: "a", currency1: "b", lpFee: 0, ethReserve: 21, liquidityLocked: true },
    fees: { creator: { unclaimedEth: 0.1, claimedEth: 0.4, recipient: "11111111111111111111111111111111", pendingRecipient: null }, marketing: { unclaimedEth: 0, claimedEth: 0 }, platform: { unclaimedEth: 0, claimedEth: 0 } },
    launchTx: "sig",
    creatorLaunchBuyTokens: 0,
    creatorBalance: 0,
    creatorSold: false,
    hidden: false,
    ...over,
  };
}

export const RISK = { holders: 77, top10Pct: 42, devHoldingPct: 12, devSold: true, devSoldPct: 30, sniperHeldPct: 3, firstBlockBuyers: 2, excluded: [], updatedAt: new Date().toISOString() };

export interface Harness {
  ctx: StealthContext;
  client: Client;
  calls: Call[];
  notifications: { method: string; params: unknown }[];
  close(): Promise<void>;
}

export interface HarnessOptions {
  routes?: Record<string, Reply>;
  config?: ConfigFile;
  context?: Partial<StealthContextOptions>;
  /** Client capabilities, such as `{ elicitation: {} }`. */
  capabilities?: ClientCapabilities;
  /** How the client answers an elicitation. */
  elicit?: (message: string) => ElicitResult;
}

/** A server and a client joined in memory, with a fake API under the server. */
export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const { fetch, calls } = fakeApi(opts.routes ?? {});
  const ctx = new StealthContext({
    config: resolveConfig(opts.config ?? {}),
    configDir: path.join(tmpdir(), "stealth-mcp-test-missing"),
    logger: new Logger({ level: "emergency", write: () => undefined }),
    fetch,
    cacheTtlMs: 0,
    evmPollMs: 20,
    stakingPollMs: 20,
    ...opts.context,
  });
  const { server } = createStealthServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: opts.capabilities ?? {} });
  const notifications: Harness["notifications"] = [];
  client.fallbackNotificationHandler = async (n) => {
    notifications.push({ method: n.method, params: n.params });
  };
  if (opts.capabilities?.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => (opts.elicit ? opts.elicit(String(req.params.message)) : { action: "accept", content: { confirm: true } }));
  }
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    ctx,
    client,
    calls,
    notifications,
    close: async () => {
      await client.close();
      await server.close();
      ctx.close();
    },
  };
}

/** Calls a tool and returns its structured content, failing the test on a tool error. */
export async function call<T = Record<string, unknown>>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await h.client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${(r.content as { text: string }[])[0]?.text}`);
  return r.structuredContent as T;
}

/** Calls a tool that should fail, and returns its error. */
export async function callError(h: Harness, name: string, args: Record<string, unknown> = {}) {
  const r = await h.client.callTool({ name, arguments: args });
  if (!r.isError) throw new Error(`${name} should have failed`);
  return { text: (r.content as { text: string }[])[0]?.text ?? "", error: (r.structuredContent as { error?: { code: string; message: string } } | undefined)?.error };
}

/** A temporary config dir. Deleted by `cleanup`. Test keys are generated at run time and never written anywhere else. */
export async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "stealth-mcp-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A keystore entry for a fresh keypair, encrypted with a fast scrypt cost so tests stay quick. */
export async function testWallet(name = "test", passphrase = "correct horse battery staple") {
  const keypair = Keypair.generate();
  const crypto = await encryptSecret(keypair.secretKey, passphrase, { n: 2 ** 14 });
  const wallet: KeystoreWallet = { name, kind: "solana", address: keypair.publicKey.toBase58(), crypto };
  return { keypair, wallet, passphrase };
}

export async function writeKeystore(dir: string, wallets: KeystoreWallet[], mode = 0o600) {
  await writeFile(path.join(dir, "keystore.json"), JSON.stringify({ version: 1, wallets }, null, 2), { mode });
}

/** A signer over a fresh wallet, with its ledger in `dir`. */
export async function testSigner(dir: string, caps = { maxSolPerTx: 0.5, maxSolPerDay: 1 }, requireElicitation = false) {
  const w = await testWallet();
  const signer = new LocalSigner({ wallet: w.wallet, keypair: w.keypair, caps, ledger: SpendLedger.in(dir), requireElicitation });
  return { ...w, signer };
}

export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
