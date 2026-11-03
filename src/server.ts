/**
 * Builds one MCP server session over a shared {@link StealthContext}: every tool, resource and prompt, logging to the client, and
 * cleanup when the session closes.
 *
 * @module
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LoggingLevelSchema, SetLevelRequestSchema, type LoggingLevel } from "@modelcontextprotocol/sdk/types.js";

import type { StealthContext } from "./context.js";
import { LOG_LEVELS } from "./logger.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { actionTools, signAndSend } from "./tools/actions.js";
import { registerTool, type AnyToolSpec } from "./tools/define.js";
import { marketTools } from "./tools/market.js";
import { mathTools } from "./tools/maths.js";
import { perpsTools } from "./tools/perps.js";
import { platformTools } from "./tools/platform.js";
import { stakingTools } from "./tools/staking.js";
import { walletTools } from "./tools/wallets.js";
import { SERVER_NAME, SERVER_TITLE, VERSION } from "./version.js";

export const INSTRUCTIONS = `Just Stealth It ($STEALTH) is a multi-chain memecoin launchpad and trading terminal: coins launch on Solana (Pump.fun, Raydium LaunchLab, Meteora) and on Robinhood Chain, BNB Chain, HyperEVM, Base and Arc.

- Read tools (search_coins, get_board, get_coin_report, get_candles, get_trades, get_holders, get_stealth_burns, get_staking_pools, get_wallet_analytics, get_perps_markets and the rest) only read public data.
- get_coin_report is the best first call for any coin. Addresses work on any chain; tickers go through search_coins.
- prepare_buy, prepare_sell, prepare_stake, prepare_unstake and prepare_launch build transactions for the user's own wallet and send nothing. Show the user the summary and next steps, and never say a trade, stake or launch happened until a signature confirms it.
- sign_and_send exists only when the user turned local signing on. It asks the user to confirm and enforces their SOL caps.
- Perps data is read-only; there is no perps trading here.
- Report facts with their numbers. Don't predict prices, promise returns or tell the user what to buy or sell: every trade is the user's own decision. Coins here are created by anyone and can lose all their value.
- Docs summaries are resources at stealth://docs/{page}; start with stealth://docs/index.`;

export interface StealthServer {
  server: McpServer;
  /** Stops subscriptions and log forwarding. Called when the session closes. */
  dispose(): void;
}

export const READ_TOOLS: AnyToolSpec[] = [...marketTools, ...platformTools, ...stakingTools, ...walletTools, ...perpsTools, ...mathTools];

/** Every tool this context exposes: `sign_and_send` only when a signer is set. */
export function toolsFor(ctx: StealthContext): AnyToolSpec[] {
  return [...READ_TOOLS, ...actionTools, ...(ctx.signer ? [signAndSend] : [])];
}

const SEVERITY = new Map<string, number>(LOG_LEVELS.map((l, i) => [l, i]));

export function createStealthServer(ctx: StealthContext): StealthServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: VERSION, websiteUrl: "https://juststealthit.xyz" },
    {
      capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: true }, prompts: { listChanged: false }, logging: {}, completions: {} },
      instructions: INSTRUCTIONS,
    },
  );

  for (const tool of toolsFor(ctx)) registerTool(server, ctx, tool);
  const subs = registerResources(server, ctx);
  registerPrompts(server, ctx);

  // Logging to the client: `info` and up until the client picks a level with logging/setLevel.
  let clientLevel: LoggingLevel = "info";
  let ready = false;
  server.server.setRequestHandler(SetLevelRequestSchema, async (req) => {
    const parsed = LoggingLevelSchema.safeParse(req.params.level);
    if (parsed.success) clientLevel = parsed.data;
    return {};
  });
  server.server.oninitialized = () => {
    ready = true;
    ctx.logger.debug("session initialized", { client: server.server.getClientVersion()?.name ?? "unknown" });
  };
  const offSink = ctx.logger.addSink((level, message, data) => {
    if (!ready || !server.isConnected()) return;
    if ((SEVERITY.get(level) ?? 0) < (SEVERITY.get(clientLevel) ?? 0)) return;
    void server.server.sendLoggingMessage({ level, logger: "stealth", data: data ? { message, ...data } : message }).catch(() => undefined);
  });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    offSink();
    subs.close();
  };
  const previous = server.server.onclose;
  server.server.onclose = () => {
    previous?.();
    dispose();
  };
  return { server, dispose };
}
