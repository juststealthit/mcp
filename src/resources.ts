/**
 * Resources: `stealth://coin/{address}` (the coin report), `stealth://docs/{page}` (bundled doc summaries), `stealth://staking/{pool}`
 * (a staking pool) and `stealth://chains`. Coins and pools can be subscribed to; see `subscriptions.ts`.
 *
 * @module
 */
import { listChains } from "@juststealthit/sdk/utils";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError, SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { StealthContext } from "./context.js";
import { DOC_PAGES, DOC_SLUGS, docPage } from "./docs/pages.js";
import { NotFoundError, toMcpError } from "./errors.js";
import { jsonSafe } from "./format.js";
import { Subscriptions, parseStealthUri } from "./subscriptions.js";
import { coinReport, resolveCoin } from "./tools/coins.js";
import { findPool, poolView } from "./tools/staking.js";

const json = (uri: string, value: unknown) => ({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(jsonSafe(value), null, 1) }] });
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

export function registerResources(server: McpServer, ctx: StealthContext): Subscriptions {
  server.registerResource(
    "coin",
    new ResourceTemplate("stealth://coin/{address}", {
      list: undefined,
      complete: {
        address: async (value) => {
          if (value.length < 2) return [];
          const hits = await ctx.client.market.search(value, { limit: 8 }).catch(() => []);
          return hits.map((h) => h.address);
        },
      },
    }),
    {
      title: "Coin",
      description: "A coin's full report on any chain: market, graduation, launch, launch type, fee routing and risk. Subscribe for live updates.",
      mimeType: "application/json",
    },
    async (uri, vars) => {
      try {
        const coin = await resolveCoin(ctx, decodeURIComponent(one(vars.address)));
        return json(uri.href, await coinReport(ctx, coin));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerResource(
    "docs",
    new ResourceTemplate("stealth://docs/{page}", {
      list: async () => ({
        resources: DOC_PAGES.map((p) => ({ uri: `stealth://docs/${p.slug}`, name: p.slug, title: p.title, description: p.description, mimeType: "text/markdown" })),
      }),
      complete: { page: (value) => DOC_SLUGS.filter((s) => s.startsWith(value)) },
    }),
    { title: "Platform docs", description: "Short summaries of the Just Stealth It docs, one page per topic.", mimeType: "text/markdown" },
    async (uri, vars) => {
      const p = docPage(one(vars.page));
      if (!p) throw toMcpError(new NotFoundError(`No docs page "${one(vars.page)}". Pages: ${DOC_SLUGS.join(", ")}.`));
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: p.body }] };
    },
  );

  server.registerResource(
    "staking",
    new ResourceTemplate("stealth://staking/{pool}", {
      list: async () => {
        const pools = await ctx.client.staking
          .overview()
          .then((o) => o.pools)
          .catch(() => []);
        return { resources: pools.map((p) => ({ uri: `stealth://staking/${p.id}`, name: p.id, title: `${p.name} staking`, mimeType: "application/json" })) };
      },
      complete: { pool: async () => ctx.client.staking.overview().then((o) => o.pools.map((p) => p.id)).catch(() => ["stealth"]) },
    }),
    { title: "Staking pool", description: "A $STEALTH staking pool: rate, boosts, cooldown, totals and reward pool. Subscribe to hear when it changes.", mimeType: "application/json" },
    async (uri, vars) => {
      try {
        return json(uri.href, poolView(await findPool(ctx, one(vars.pool))));
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );

  server.registerResource(
    "chains",
    "stealth://chains",
    { title: "Chains", description: "Every chain the platform runs on or has announced.", mimeType: "application/json" },
    async (uri) => json(uri.href, { chains: listChains() }),
  );

  const subs = new Subscriptions(ctx, (uri) => server.server.sendResourceUpdated({ uri }));
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (!parseStealthUri(uri)) throw new McpError(ErrorCode.InvalidParams, `Unknown resource ${uri}.`);
    try {
      await subs.subscribe(uri);
    } catch (error) {
      throw toMcpError(error);
    }
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subs.unsubscribe(req.params.uri);
    return {};
  });
  return subs;
}
