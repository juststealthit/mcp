#!/usr/bin/env node
/**
 * `stealth-mcp`: runs the server on stdio (the default) or Streamable HTTP. Logs go to stderr only.
 *
 * @module
 */
import { parseArgs } from "node:util";

import type { WebSocketConstructor } from "@juststealthit/sdk/live";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SpendLedger } from "./actions/ledger.js";
import { LocalSigner } from "./actions/signing.js";
import { CHAIN_KEYS, EVM_CHAIN_KEYS, configDir, isEvmChain, loadConfig, type ChainKey, type EvmChain } from "./config.js";
import { StealthContext } from "./context.js";
import { isLoopback, startHttpServer } from "./http.js";
import { KeystoreError, pickWallet, readKeystore, unlockSolanaWallet } from "./keystore.js";
import { Logger, isLogLevel, type LogLevel } from "./logger.js";
import { createStealthServer } from "./server.js";
import { promptPassphrase } from "./tty.js";
import { SERVER_NAME, VERSION } from "./version.js";

const HELP = `${SERVER_NAME} ${VERSION}: the Just Stealth It MCP server

Usage: stealth-mcp [options]

Transport
  --http                    Serve Streamable HTTP instead of stdio
  --port <n>                HTTP port (default 8765)
  --host <addr>             HTTP bind address (default 127.0.0.1)
  --auth-token <token>      Require "Authorization: Bearer <token>" (or set STEALTH_MCP_TOKEN)
  --allow-origin <origin>   Allow a browser origin besides loopback ones (repeatable)
  --allowed-host <host>     Accept this Host header when bound beyond loopback (repeatable)

Data
  --api-url <url>           API base URL (default: config.json's apiUrl, else the official API)
  --config-dir <dir>        The shared config directory (default: $XDG_CONFIG_HOME/stealth or ~/.config/stealth)
  --rpc <chain=url>         RPC for an EVM chain's direct reads (repeatable), e.g. --rpc base=https://…
  --timeout <ms>            Per-request timeout (default 15000)
  --cache-ttl <ms>          Cache API reads this long; 0 turns it off (default 5000)

Signing (off by default)
  --allow-signing           Sign prepared Solana actions with a keystore wallet. The passphrase comes from
                            STEALTH_KEYSTORE_PASSPHRASE or a prompt on the terminal. Caps: config.json "mcp"
  --wallet <name>           The keystore wallet to sign with (default: the first Solana wallet)
  --require-elicitation     Refuse to sign for a client that can't show a confirmation
  --read-only               Never sign, even if config.json allows it

Other
  --log-level <level>       debug, info, notice, warning or error (default info)
  --log-json                One JSON object per log line
  -v, --version             Print the version
  -h, --help                Print this help
`;

type Flags = {
  http?: boolean;
  port?: string;
  host?: string;
  "auth-token"?: string;
  "allow-origin"?: string[];
  "allowed-host"?: string[];
  "api-url"?: string;
  "config-dir"?: string;
  rpc?: string[];
  timeout?: string;
  "cache-ttl"?: string;
  "allow-signing"?: boolean;
  wallet?: string;
  "require-elicitation"?: boolean;
  "read-only"?: boolean;
  "log-level"?: string;
  "log-json"?: boolean;
  version?: boolean;
  help?: boolean;
};

function parse(argv: string[]): Flags {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      http: { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      "auth-token": { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      "allowed-host": { type: "string", multiple: true },
      "api-url": { type: "string" },
      "config-dir": { type: "string" },
      rpc: { type: "string", multiple: true },
      timeout: { type: "string" },
      "cache-ttl": { type: "string" },
      "allow-signing": { type: "boolean" },
      wallet: { type: "string" },
      "require-elicitation": { type: "boolean" },
      "read-only": { type: "boolean" },
      "log-level": { type: "string" },
      "log-json": { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  return values as Flags;
}

const int = (v: string | undefined, name: string, min: number, max: number): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
  return n;
};

function rpcMap(list: string[] = []): Partial<Record<EvmChain, string>> {
  const out: Partial<Record<EvmChain, string>> = {};
  for (const item of list) {
    const at = item.indexOf("=");
    const chain = item.slice(0, at);
    const url = item.slice(at + 1);
    if (at < 1 || !isEvmChain(chain)) throw new Error(`--rpc takes chain=url, with chain one of ${EVM_CHAIN_KEYS.join(", ")}.`);
    if (!/^https?:\/\//.test(url)) throw new Error(`--rpc ${chain}: the URL must start with http:// or https://.`);
    out[chain] = url;
  }
  return out;
}

async function webSocketCtor(): Promise<WebSocketConstructor | undefined> {
  if ((globalThis as { WebSocket?: unknown }).WebSocket) return undefined;
  try {
    return (await import("ws")).WebSocket as unknown as WebSocketConstructor;
  } catch {
    return undefined;
  }
}

async function main() {
  let flags: Flags;
  try {
    flags = parse(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const level = flags["log-level"] ?? process.env.STEALTH_MCP_LOG_LEVEL ?? "info";
  if (!isLogLevel(level)) throw new Error(`--log-level must be one of debug, info, notice, warning, error.`);
  const logger = new Logger({ level: level as LogLevel, json: flags["log-json"] });

  const dir = flags["config-dir"] ?? configDir();
  const loaded = await loadConfig(dir);
  for (const p of loaded.problems) logger.warn(`config.json: ${p}. Using defaults; signing stays off.`);
  const config = { ...loaded.config };
  const apiUrl = flags["api-url"] ?? process.env.STEALTH_API_URL;
  if (apiUrl) {
    if (!/^https?:\/\//.test(apiUrl)) throw new Error("--api-url must start with http:// or https://.");
    config.apiUrl = apiUrl.replace(/\/+$/, "");
  }
  if (!(CHAIN_KEYS as readonly string[]).includes(config.defaultChain)) config.defaultChain = "solana" as ChainKey;

  const http = flags.http === true;
  const host = flags.host ?? "127.0.0.1";

  // ---- signing --------------------------------------------------------------------------------------------------------
  let signer: LocalSigner | null = null;
  let signingOffReason: string | undefined;
  const wantSigning = !flags["read-only"] && (flags["allow-signing"] === true || config.mcp.allowSigning);
  if (!wantSigning) signingOffReason = flags["read-only"] ? "Started with --read-only." : undefined;
  else if (loaded.problems.length) signingOffReason = "config.json has problems, so signing stays off.";
  else if (http && !isLoopback(host)) signingOffReason = "Signing is only allowed while the HTTP server is bound to loopback.";
  else {
    try {
      const keystore = await readKeystore(dir);
      for (const w of keystore.warnings) logger.warn(w);
      const wallet = pickWallet(keystore.wallets, "solana", flags.wallet);
      if (!wallet) signingOffReason = flags.wallet ? `No wallet named "${flags.wallet}" in the keystore.` : "The keystore has no Solana wallet.";
      else {
        const fromEnv = process.env.STEALTH_KEYSTORE_PASSPHRASE;
        delete process.env.STEALTH_KEYSTORE_PASSPHRASE;
        const passphrase = fromEnv ?? (await promptPassphrase(`Passphrase for keystore wallet "${wallet.name}": `, { allowStdin: http }));
        if (!passphrase) signingOffReason = "No passphrase: set STEALTH_KEYSTORE_PASSPHRASE, or start the server from a terminal to be asked.";
        else {
          const keypair = await unlockSolanaWallet(wallet, passphrase);
          signer = new LocalSigner({
            wallet,
            keypair,
            caps: { maxSolPerTx: config.mcp.maxSolPerTx, maxSolPerDay: config.mcp.maxSolPerDay },
            ledger: SpendLedger.in(dir),
            requireElicitation: flags["require-elicitation"] === true,
          });
          logger.notice(`Local signing is on for wallet "${wallet.name}" (${wallet.address}). Caps: ${config.mcp.maxSolPerTx} SOL per transaction, ${config.mcp.maxSolPerDay} SOL per 24 h.`);
        }
      }
    } catch (error) {
      if (error instanceof KeystoreError && error.code === "not_found") signingOffReason = "No keystore found. Create one with the Stealth CLI.";
      else throw error;
    }
  }
  if (wantSigning && !signer) logger.warn(`Signing requested but off: ${signingOffReason}`);

  const ctx = new StealthContext({
    config,
    configDir: dir,
    logger,
    timeoutMs: int(flags.timeout, "timeout", 1_000, 120_000),
    cacheTtlMs: int(flags["cache-ttl"], "cache-ttl", 0, 600_000),
    rpcUrls: rpcMap(flags.rpc),
    WebSocket: await webSocketCtor(),
    signer,
    signingOffReason,
  });

  let stopping = false;
  let stop: () => Promise<void> = async () => undefined;
  const shutdown = async (why: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    logger.info(`shutting down (${why})`);
    const force = setTimeout(() => process.exit(code), 5_000);
    force.unref();
    try {
      await stop();
    } catch (error) {
      logger.error("error while shutting down", { error: String(error) });
    }
    ctx.close();
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) }));
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", { error: error.message });
    void shutdown("uncaught exception", 1);
  });

  if (http) {
    const token = flags["auth-token"] ?? process.env.STEALTH_MCP_TOKEN;
    const running = await startHttpServer(ctx, {
      host,
      port: int(flags.port, "port", 0, 65_535) ?? 8765,
      token,
      allowedOrigins: flags["allow-origin"],
      allowedHosts: flags["allowed-host"],
    });
    stop = running.close;
    logger.notice(`${SERVER_NAME} ${VERSION} listening on ${running.url}${token ? " (bearer auth on)" : ""}`);
  } else {
    const { server, dispose } = createStealthServer(ctx);
    const transport = new StdioServerTransport();
    stop = async () => {
      dispose();
      await server.close();
    };
    process.stdin.on("end", () => void shutdown("stdin closed"));
    process.stdin.on("close", () => void shutdown("stdin closed"));
    await server.connect(transport);
    logger.info(`${SERVER_NAME} ${VERSION} ready on stdio (${signer ? "local signing on" : "prepare-only"})`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[stealth-mcp] error   ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
