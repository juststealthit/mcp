/**
 * @juststealthit/mcp as a library: build the server into your own process, over any MCP transport.
 *
 * ```ts
 * import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 * import { StealthContext, createStealthServer, loadConfig } from "@juststealthit/mcp";
 *
 * const { config, dir } = await loadConfig();
 * const ctx = new StealthContext({ config, configDir: dir });
 * const { server } = createStealthServer(ctx);
 * await server.connect(new StdioServerTransport());
 * ```
 *
 * @module
 */
export { createStealthServer, toolsFor, INSTRUCTIONS, READ_TOOLS, type StealthServer } from "./server.js";
export { StealthContext, watchOnlySigner, type StealthContextOptions } from "./context.js";
export { startHttpServer, isLoopback, type HttpOptions, type RunningHttpServer } from "./http.js";
export {
  CHAIN_KEYS,
  EVM_CHAIN_KEYS,
  DEFAULT_SIGNING_CAPS,
  ConfigFileSchema,
  configDir,
  loadConfig,
  resolveConfig,
  type ChainKey,
  type ConfigFile,
  type EvmChain,
  type LoadedConfig,
  type ResolvedConfig,
} from "./config.js";
export {
  KDF_DEFAULTS,
  KeystoreError,
  KeystoreFileSchema,
  decryptSecret,
  encryptSecret,
  evmAccountFrom,
  pickWallet,
  readKeystore,
  solanaKeypairFrom,
  unlockSolanaWallet,
  type KeystoreFile,
  type KeystoreWallet,
  type LoadedKeystore,
} from "./keystore.js";
export { LocalSigner, type LocalSignerOptions, type SigningCaps } from "./actions/signing.js";
export { SpendLedger, DailyCapError } from "./actions/ledger.js";
export { PreparedStore, PREPARED_TTL_MS, type PreparedAction } from "./actions/prepared.js";
export { Logger, LOG_LEVELS, type LogLevel, type LogSink } from "./logger.js";
export { StealthMcpError, NotFoundError, RefusedError, describeError, toolError, toMcpError } from "./errors.js";
export { DOC_PAGES, docPage } from "./docs/pages.js";
export { Links } from "./links.js";
export { SERVER_NAME, VERSION } from "./version.js";
