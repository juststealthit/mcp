import path from "node:path";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";
import { StealthContext } from "../src/context.js";
import { startHttpServer, type RunningHttpServer } from "../src/http.js";
import { Logger } from "../src/logger.js";
import { fakeApi } from "./helpers.js";

const TOKEN = "a-long-enough-test-token";
let running: RunningHttpServer | null = null;
let ctx: StealthContext | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
  ctx?.close();
  ctx = null;
});

function context() {
  ctx = new StealthContext({ config: resolveConfig(), configDir: path.join(tmpdir(), "stealth-mcp-none"), logger: new Logger({ level: "emergency", write: () => undefined }), fetch: fakeApi({}).fetch, cacheTtlMs: 0 });
  return ctx;
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const post = (url: string, headers: Record<string, string>, body: unknown = init) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

describe("streamable HTTP", () => {
  it("serves MCP to a client with the token", async () => {
    running = await startHttpServer(context(), { port: 0, token: TOKEN });
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = new Client({ name: "http-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === "get_coin_report")).toBe(true);
    const r = await client.callTool({ name: "calc_sniper_fee", arguments: { tierBps: 225, secondsSinceLaunch: 15 } });
    expect((r.structuredContent as { feeBps: number }).feeBps).toBe(225);
    expect(running.sessions()).toBe(1);
    await client.close();
  });

  it("refuses a missing or wrong token", async () => {
    running = await startHttpServer(context(), { port: 0, token: TOKEN });
    const none = await post(running.url, {});
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect((await post(running.url, { authorization: "Bearer wrong-token-of-some-length" })).status).toBe(401);
  });

  it("refuses foreign origins and hosts, which is what DNS rebinding looks like", async () => {
    running = await startHttpServer(context(), { port: 0 });
    expect((await post(running.url, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(running.url, { origin: "http://localhost:5173" })).status).toBe(200);
    const port = new URL(running.url).port;
    const raw = await new Promise<number>((resolve, reject) => {
      // fetch won't let a test forge Host, so use a raw request
      import("node:http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: `rebound.example:${port}`, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end(JSON.stringify(init));
      });
    });
    expect(raw).toBe(403);
  });

  it("allows an origin it was told to", async () => {
    running = await startHttpServer(context(), { port: 0, allowedOrigins: ["https://app.example"] });
    const r = await post(running.url, { origin: "https://app.example" });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  it("answers health checks, unknown paths and sessionless requests sensibly", async () => {
    running = await startHttpServer(context(), { port: 0 });
    const base = running.url.replace(/\/mcp$/, "");
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ status: "ok", name: "stealth-mcp" });
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect((await post(running.url, {}, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(400);
    expect((await post(running.url, { "mcp-session-id": "nope" }, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(404);
    const bad = await fetch(running.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(bad.status).toBe(400);
  });

  it("keeps a session with an open stream past the idle timeout, and closes one that went quiet", async () => {
    running = await startHttpServer(context(), { port: 0, sessionIdleMs: 60 });
    const client = new Client({ name: "http-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    // the client holds its GET stream open for server notifications: that session is in use
    await client.listTools();
    await new Promise((r) => setTimeout(r, 300));
    expect(running.sessions()).toBe(1);
    expect((await client.callTool({ name: "list_chains", arguments: {} })).isError).toBeFalsy();
    await client.close();

    // a bare initialize with nothing after it is idle
    const r = await post(running.url, {});
    expect(r.status).toBe(200);
    await r.text();
    await new Promise((r) => setTimeout(r, 300));
    expect(running.sessions()).toBe(0);
  });

  it("counts sessions still initializing against the cap", async () => {
    running = await startHttpServer(context(), { port: 0, maxSessions: 2 });
    const replies = await Promise.all(Array.from({ length: 6 }, () => post(running!.url, {})));
    await Promise.all(replies.map((r) => r.text()));
    expect(replies.filter((r) => r.status === 200)).toHaveLength(2);
    expect(replies.filter((r) => r.status === 503)).toHaveLength(4);
    expect(running.sessions()).toBe(2);
  });

  it("drops the server behind an initialize the transport turned down", async () => {
    running = await startHttpServer(context(), { port: 0, maxSessions: 1 });
    // no text/event-stream in accept: the transport answers 406 and opens no session
    const bad = await fetch(running.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(init) });
    expect(bad.status).toBe(406);
    // the failed one doesn't hold the only slot
    expect((await post(running.url, {})).status).toBe(200);
  });

  it("won't listen beyond loopback without a token", async () => {
    await expect(startHttpServer(context(), { port: 0, host: "0.0.0.0" })).rejects.toThrow(/without a bearer token/);
    await expect(startHttpServer(context(), { port: 0, token: "short" })).rejects.toThrow(/at least 16/);
  });
});
