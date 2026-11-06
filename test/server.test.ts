import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";
import { harness, tempDir, testSigner, type Harness } from "./helpers.js";

let h: Harness | null = null;
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  await cleanup?.();
  cleanup = null;
});

const READ_ONLY = [
  "search_coins",
  "get_board",
  "get_trending",
  "get_coin_report",
  "get_candles",
  "get_trades",
  "get_holders",
  "get_top_traders",
  "get_chart_events",
  "get_stealth_burns",
  "get_feed",
  "get_fee_board",
  "get_platform_status",
  "get_platform_stats",
  "get_launch_options",
  "list_chains",
  "get_staking_pools",
  "get_staking_position",
  "calc_staking_estimate",
  "get_wallet_overview",
  "get_wallet_analytics",
  "get_perps_markets",
  "get_perps_candles",
  "quote_trade",
  "calc_sniper_fee",
  "calc_fee_split",
  "calc_curve_quote",
  "get_signing_status",
  "get_transaction_status",
];
const PREPARE = ["prepare_buy", "prepare_sell", "prepare_stake", "prepare_unstake", "prepare_launch"];

describe("server", () => {
  it("reports its name and version, and the package agrees", async () => {
    h = await harness();
    expect(h.client.getServerVersion()).toMatchObject({ name: "stealth-mcp", version: VERSION });
    expect(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version).toBe(VERSION);
    const registry = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
    expect(registry.version).toBe(VERSION);
    expect(registry.packages[0].version).toBe(VERSION);
    // the registry's limit
    expect(registry.description.length).toBeLessThanOrEqual(100);
    expect(h.client.getInstructions()).toMatch(/never say a trade/i);
  });

  it("lists every tool with schemas and honest annotations, and no signing tool by default", async () => {
    h = await harness();
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names.sort()).toEqual([...READ_ONLY, ...PREPARE].sort());
    expect(names).not.toContain("sign_and_send");
    for (const t of tools) {
      expect(t.description?.length, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type, t.name).toBe("object");
      expect(t.annotations?.title, t.name).toBeTruthy();
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
    }
    for (const n of READ_ONLY) expect(tools.find((t) => t.name === n)?.annotations?.readOnlyHint, n).toBe(true);
    for (const n of PREPARE) expect(tools.find((t) => t.name === n)?.annotations?.readOnlyHint, n).toBe(false);
  });

  it("offers sign_and_send, marked destructive, only with a signer", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const { signer } = await testSigner(t.dir);
    h = await harness({ context: { signer, configDir: t.dir } });
    const tool = (await h.client.listTools()).tools.find((x) => x.name === "sign_and_send");
    expect(tool?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false, idempotentHint: false });
  });

  it("lists resource templates, docs pages and prompts", async () => {
    h = await harness();
    const templates = (await h.client.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate);
    expect(templates).toEqual(expect.arrayContaining(["stealth://coin/{address}", "stealth://docs/{page}", "stealth://staking/{pool}"]));
    expect((await h.client.listResources()).resources.map((r) => r.uri)).toEqual(expect.arrayContaining(["stealth://feed", "stealth://trending"]));
    const resources = (await h.client.listResources()).resources.map((r) => r.uri);
    expect(resources).toEqual(expect.arrayContaining(["stealth://chains", "stealth://docs/index", "stealth://docs/fees", "stealth://docs/launch-types"]));
    const prompts = (await h.client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(["analyze_coin", "compare_coins", "explain_launch_type", "daily_burn_report", "review_wallet", "trending_now", "plan_launch"]);
  });

  it("completes prompt and template arguments", async () => {
    h = await harness();
    const r = await h.client.complete({ ref: { type: "ref/prompt", name: "explain_launch_type" }, argument: { name: "type", value: "bu" } });
    expect(r.completion.values).toEqual(["buyback"]);
    const d = await h.client.complete({ ref: { type: "ref/resource", uri: "stealth://docs/{page}" }, argument: { name: "page", value: "st" } });
    expect(d.completion.values).toEqual(["stealth-bc-amm", "staking"]);
    const c = await h.client.complete({ ref: { type: "ref/prompt", name: "trending_now" }, argument: { name: "chain", value: "b" } });
    expect(c.completion.values).toEqual(["bnb", "base"]);
  });

  it("builds prompts that embed the docs they rely on", async () => {
    h = await harness();
    const p = await h.client.getPrompt({ name: "explain_launch_type", arguments: { type: "holders" } });
    expect(p.messages).toHaveLength(3);
    expect(JSON.stringify(p.messages[0])).toMatch(/Holders/);
    expect(p.messages[1]?.content).toMatchObject({ type: "resource", resource: { uri: "stealth://docs/launch-types" } });
    const trending = await h.client.getPrompt({ name: "trending_now", arguments: { chain: "base" } });
    expect(JSON.stringify(trending.messages)).toMatch(/get_trending with chains \[\\"base\\"\]/);
    const burn = await h.client.getPrompt({ name: "daily_burn_report" });
    expect(JSON.stringify(burn.messages)).toMatch(/get_stealth_burns/);
  });

  it("sends log messages to the client at the level it asked for", async () => {
    h = await harness();
    await h.client.setLoggingLevel("debug");
    h.ctx.logger.debug("hello from the server", { token: "secret-value" });
    await new Promise((r) => setTimeout(r, 20));
    const log = h.notifications.find((n) => n.method === "notifications/message");
    expect(log?.params).toMatchObject({ level: "debug", logger: "stealth", data: { message: "hello from the server", token: "[redacted]" } });
  });
});
