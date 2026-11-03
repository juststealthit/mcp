/**
 * Prompts: ready-made requests a user can pick in their client. Each one tells the model which tools to use and how to present the
 * answer, facts first and with no promises.
 *
 * @module
 */
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { StealthContext } from "./context.js";
import { docPage } from "./docs/pages.js";
import { LAUNCH_TYPES } from "./format.js";

const RULES =
  "Report facts from the tools, with their numbers and links. Don't predict prices, don't promise returns and don't tell the user to buy or sell: the decision is theirs. Say when a figure is missing rather than guessing it.";

const user = (text: string): GetPromptResult["messages"][number] => ({ role: "user", content: { type: "text", text } });

export function registerPrompts(server: McpServer, ctx: StealthContext) {
  const coinArg = completable(z.string().describe("A coin's address, or its ticker"), async (value) => {
    if (value.length < 2) return [];
    const hits = await ctx.client.market.search(value.replace(/^\$/, ""), { limit: 8 }).catch(() => []);
    return hits.map((h) => h.address);
  });

  server.registerPrompt(
    "analyze_coin",
    {
      title: "Analyze a coin",
      description: "A structured look at one coin: market, graduation, launch type and fee routing, holder risk and recent activity.",
      argsSchema: { coin: coinArg, chain: z.string().optional().describe("solana, robinhood, bnb, hyperevm, base or arc") },
    },
    ({ coin, chain }) => ({
      description: `Analysis of ${coin}`,
      messages: [
        user(
          `Analyze the coin ${coin}${chain ? ` on ${chain}` : ""} on Just Stealth It.\n\n` +
            `1. If ${coin} isn't an address, find it with search_coins first.\n` +
            "2. Call get_coin_report. Then get_holders, get_trades (limit 25) and get_candles (interval 15m, limit 96).\n" +
            "3. Write: a one-line overview; market (price, market cap, liquidity, 24 h volume, holders); stage and graduation progress; venue, pair and tax, and whether the anti-sniper window is open; " +
            "the launch type and exactly where creator fees go; the risk card with its green/amber/red bands; what the last day of trades and candles shows; and anything in warnings.\n" +
            `4. End with the token page link.\n\n${RULES}`,
        ),
      ],
    }),
  );

  server.registerPrompt(
    "compare_coins",
    {
      title: "Compare two coins",
      description: "Two coins side by side: market, stage, launch type, fee routing and risk.",
      argsSchema: { first: coinArg, second: coinArg },
    },
    ({ first, second }) => ({
      description: `${first} vs ${second}`,
      messages: [
        user(
          `Compare ${first} and ${second} on Just Stealth It. Call get_coin_report for each (search_coins first for a ticker). ` +
            "Show one table with a row per field: chain, venue, stage and graduation progress, price, market cap, liquidity, 24 h volume, holders, 24 h change, tax, launch type, what the coin gets per trade, top-10 share, launcher + creator share, sniper share. " +
            `Then a few sentences on the differences that stand out. Don't rank them as investments.\n\n${RULES}`,
        ),
      ],
    }),
  );

  const typeArg = completable(z.string().describe("A launch type, such as holders or buyback"), (value) => Object.keys(LAUNCH_TYPES).filter((k) => k.startsWith(value.toLowerCase())));

  server.registerPrompt(
    "explain_launch_type",
    {
      title: "Explain a launch type",
      description: "What a launch type does with creator fees, with an example, from the platform's docs.",
      argsSchema: { type: typeArg },
    },
    ({ type }) => {
      const key = type.toLowerCase().replace(/[^a-z]/g, "");
      const known = LAUNCH_TYPES[key] ?? Object.entries(LAUNCH_TYPES).find(([, v]) => v.label.toLowerCase().replace(/[^a-z]/g, "") === key)?.[1];
      const doc = docPage("launch-types")!;
      const fees = docPage("fees")!;
      return {
        description: `The ${known?.label ?? type} launch type`,
        messages: [
          user(
            `Explain the "${known?.label ?? type}" launch type on Just Stealth It to someone deciding how to launch.${known ? ` In short: ${known.summary}` : ""}\n\n` +
              "Use the two attached docs pages. Cover: where creator fees go and when, what the launcher gets, what's locked, how it differs by venue and on EVM chains, and one worked example with a small trade (use calc_fee_split for the numbers). " +
              `Be clear that creator fees are the coin's part of the fee, not the whole tax, and that a coin nobody trades earns nothing.\n\n${RULES}`,
          ),
          { role: "user", content: { type: "resource", resource: { uri: "stealth://docs/launch-types", mimeType: "text/markdown", text: doc.body } } },
          { role: "user", content: { type: "resource", resource: { uri: "stealth://docs/fees", mimeType: "text/markdown", text: fees.body } } },
        ],
      };
    },
  );

  server.registerPrompt(
    "daily_burn_report",
    {
      title: "Daily $STEALTH burn report",
      description: "The last day of the $STEALTH buy back and burn: what was bought back and burned, the fees behind it, and when the next one runs.",
      argsSchema: {},
    },
    () => ({
      description: "$STEALTH burn report",
      messages: [
        user(
          "Write today's $STEALTH buy back and burn report. Call get_stealth_burns with range 24h, recent 20 and topCoins 10, and get_fee_board with days 7.\n\n" +
            "Sections: supply now and the share burned so far; burns in the last 24 hours (count, tokens, SOL spent, each with its transaction link); fees in the last 24 hours and 7 days; the coins whose fees funded it most; when the next burn runs. " +
            `Keep it short and factual. A burn reduces supply; it isn't a promise of any price or value.\n\n${RULES}`,
        ),
      ],
    }),
  );

  server.registerPrompt(
    "review_wallet",
    {
      title: "Review a wallet",
      description: "A Solana wallet's record on the launchpad: PnL by period, positions, rewards and trading style.",
      argsSchema: { address: z.string().describe("A Solana wallet address") },
    },
    ({ address }) => ({
      description: `Wallet ${address}`,
      messages: [
        user(
          `Review the Solana wallet ${address} on Just Stealth It. Call get_wallet_analytics with view summary, then pnl (range 30d), rewards and portfolio. ` +
            `Summarise PnL by period, the biggest open and closed positions, rewards earned and owed, and the trading style. Past results say nothing about future ones.\n\n${RULES}`,
        ),
      ],
    }),
  );

  server.registerPrompt(
    "plan_launch",
    {
      title: "Plan a launch",
      description: "Walks through a launch's choices (chain, venue, pair, tax, launch type, first buy) and prepares it for the user to sign.",
      argsSchema: { idea: z.string().describe("The coin: name, ticker and what it's about"), chain: z.string().optional().describe("Where to launch, if decided") },
    },
    ({ idea, chain }) => ({
      description: "Launch plan",
      messages: [
        user(
          `Help me plan a launch on Just Stealth It: ${idea}${chain ? ` (on ${chain})` : ""}.\n\n` +
            "1. Call get_launch_options to see what's open right now.\n" +
            "2. Walk me through each choice in turn, with the trade-offs from the docs (read stealth://docs/venues, stealth://docs/fees and stealth://docs/launch-types): chain and venue, pair, tax tier, launch type, and an optional first buy. Ask me to decide each one; don't decide for me.\n" +
            "3. Remind me what's locked at launch and what it costs.\n" +
            "4. When I've decided everything, call prepare_launch and show me its summary, transactions and next steps. Never say the coin is launched: it isn't until I sign and send it.\n\n" +
            RULES,
        ),
      ],
    }),
  );
}
