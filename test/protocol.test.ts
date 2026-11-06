/**
 * MCP protocol details that clients rely on: error results that pass the client's own output-schema check, elicitation modes, and
 * log notifications that stay with the session they belong to.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { errorOf } from "../src/errors.js";
import { createStealthServer } from "../src/server.js";
import { harness, tempDir, testSigner, type Harness } from "./helpers.js";

let h: Harness | null = null;
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  await cleanup?.();
  cleanup = null;
});

describe("tool errors", () => {
  it("reach a client that validates output schemas as errors, not as schema failures", async () => {
    h = await harness();
    // listing the tools makes the client check every later result against its output schema
    await h.client.listTools();
    const r = await h.client.callTool({ name: "get_staking_position", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(errorOf(r as never)?.code).toBe("owner_required");
  });

  it("keeps the input validation failure readable", async () => {
    h = await harness();
    await h.client.listTools();
    const r = await h.client.callTool({ name: "get_board", arguments: { limit: 5000 } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/limit/);
  });
});

describe("elicitation", () => {
  it("doesn't count a client that offers only URL elicitation as able to confirm", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const { signer } = await testSigner(t.dir);
    h = await harness({ context: { signer, configDir: t.dir }, capabilities: { elicitation: { url: {} } } });
    const r = await h.client.callTool({ name: "get_signing_status", arguments: {} });
    expect((r.structuredContent as { clientCanConfirm: boolean }).clientCanConfirm).toBe(false);
  });

  it("counts an empty elicitation capability as form support, as the spec says", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const { signer } = await testSigner(t.dir);
    h = await harness({ context: { signer, configDir: t.dir }, capabilities: { elicitation: {} } });
    const r = await h.client.callTool({ name: "get_signing_status", arguments: {} });
    expect((r.structuredContent as { clientCanConfirm: boolean }).clientCanConfirm).toBe(true);
  });
});

describe("log notifications", () => {
  it("send a tool call's log lines to the session that made the call, and server-wide lines to all", async () => {
    h = await harness();
    // a second session over the same context, as the HTTP transport runs them
    const second = createStealthServer(h.ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const other = new Client({ name: "other", version: "1" });
    const seen: unknown[] = [];
    other.fallbackNotificationHandler = async (n) => {
      if (n.method === "notifications/message") seen.push(n.params);
    };
    await Promise.all([second.server.connect(b), other.connect(a)]);
    try {
      await h.client.setLoggingLevel("debug");
      await other.setLoggingLevel("debug");
      await h.client.callTool({ name: "calc_fee_split", arguments: { venue: "evm", tierBps: 225 } });
      h.ctx.logger.info("server-wide line");
      await new Promise((r) => setTimeout(r, 30));
      const mine = h.notifications.filter((n) => n.method === "notifications/message").map((n) => JSON.stringify(n.params));
      expect(mine.some((m) => m.includes("tool calc_fee_split"))).toBe(true);
      expect(seen.map((x) => JSON.stringify(x)).some((m) => m.includes("calc_fee_split"))).toBe(false);
      expect(seen.map((x) => JSON.stringify(x)).some((m) => m.includes("server-wide line"))).toBe(true);
    } finally {
      await other.close();
      second.dispose();
    }
  });
});
