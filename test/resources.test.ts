import type { WebSocketLike } from "@juststealthit/sdk/live";
import { afterEach, describe, expect, it } from "vitest";

const text = (r: { contents: unknown[] }) => String((r.contents[0] as { text?: string }).text);

import { Subscriptions, THROTTLE_MS, parseStealthUri, throttle } from "../src/subscriptions.js";
import { MINT, RISK, harness, solToken, tick, type Harness } from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  FakeSocket.all = [];
});

/** A WebSocket stand-in the test can open and push messages through. */
class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  push(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const coinRoutes = { [`GET /sol/tokens/${MINT}`]: solToken(), [`GET /sol/tokens/${MINT}/risk`]: RISK };

describe("resources", () => {
  it("reads docs pages and refuses unknown ones with a resource error", async () => {
    h = await harness();
    const r = await h.client.readResource({ uri: "stealth://docs/anti-sniper" });
    expect(r.contents[0]).toMatchObject({ mimeType: "text/markdown" });
    expect(text(r)).toMatch(/90%/);
    await expect(h.client.readResource({ uri: "stealth://docs/nope" })).rejects.toMatchObject({ code: -32002 });
  });

  it("reads a coin as its full report", async () => {
    h = await harness({ routes: coinRoutes });
    const r = await h.client.readResource({ uri: `stealth://coin/${MINT}` });
    const body = JSON.parse(text(r));
    expect(body).toMatchObject({ symbol: "TEST", launchType: { id: "holders" } });
  });

  it("reads the chain registry", async () => {
    h = await harness();
    const r = await h.client.readResource({ uri: "stealth://chains" });
    expect(JSON.parse(text(r)).chains.length).toBeGreaterThan(5);
  });

  it("tells a subscriber when a Solana coin trades, over the live stream, throttled", async () => {
    h = await harness({ routes: coinRoutes, context: { WebSocket: FakeSocket } });
    const uri = `stealth://coin/${MINT}`;
    await h.client.subscribeResource({ uri });
    await tick(20);
    const sock = FakeSocket.all[0]!;
    expect(sock.url).toBe("wss://juststealthit.xyz/api/sol/ws");
    expect(sock.sent).toContainEqual({ op: "sub", ch: `token:${MINT.toLowerCase()}` });
    for (let i = 0; i < 5; i++) sock.push({ ch: `token:${MINT.toLowerCase()}`, type: "trade", trade: {}, token: {} });
    await tick(30);
    const updates = () => h!.notifications.filter((n) => n.method === "notifications/resources/updated");
    expect(updates()).toHaveLength(1);
    expect(updates()[0]?.params).toEqual({ uri });
    await tick(THROTTLE_MS + 100);
    expect(updates()).toHaveLength(2); // the burst's trailing update
    await h.client.unsubscribeResource({ uri });
    sock.push({ ch: `token:${MINT.toLowerCase()}`, type: "trade", trade: {}, token: {} });
    await tick(THROTTLE_MS + 100);
    expect(updates()).toHaveLength(2);
  }, 15_000);

  it("polls an EVM coin, which has no stream", async () => {
    const A = "0x8cf19c89ca5ca6fb137ebafdce681bcc48f67eba";
    let n = 0;
    const evmTok = { ...solToken({ address: A }), sol: undefined, feeMode: "creator", evm: { chain: "base", chainId: 8453, native: "ETH", launchType: "creator", rules: 0, dex: "v4", feeVault: "0x", settlement: "0x" }, feePlan: null };
    h = await harness({
      routes: {
        [`GET /evm/chains/base/tokens/${A}`]: evmTok,
        [`GET /evm/chains/base/tokens/${A}/trades`]: () => ({ items: [{ id: `t${n++}`, timestamp: Date.now() }], nextCursor: null, total: 1 }),
      },
    });
    await h.client.subscribeResource({ uri: `stealth://coin/${A}` });
    await tick(120);
    expect(h.notifications.some((x) => x.method === "notifications/resources/updated")).toBe(true);
  });

  it("refuses to subscribe to something that isn't a resource", async () => {
    h = await harness();
    await expect(h.client.subscribeResource({ uri: "https://example.com" })).rejects.toThrow(/Unknown resource/);
  });
});

describe("subscription bookkeeping", () => {
  const A = "0x8cf19c89ca5ca6fb137ebafdce681bcc48f67eba";
  /** An EVM coin whose lookup waits until the test lets it go, and a counter of trade polls (one per running watcher). */
  function slowEvm() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let polls = 0;
    const evmTok = { ...solToken({ address: A }), sol: undefined, feeMode: "creator", evm: { chain: "base", chainId: 8453, native: "ETH", launchType: "creator", rules: 0, dex: "v4", feeVault: "0x", settlement: "0x" }, feePlan: null };
    const routes = {
      [`GET /evm/chains/base/tokens/${A}`]: async () => {
        await gate;
        return evmTok;
      },
      [`GET /evm/chains/base/tokens/${A}/trades`]: () => {
        polls++;
        return { items: [], nextCursor: null, total: 0 };
      },
    };
    return { routes, release: () => release(), polls: () => polls };
  }

  const fakeCtx = async (routes: Record<string, unknown>) => {
    h = await harness({ routes: routes as never, context: { evmPollMs: 10 } });
    return h.ctx;
  };

  it("starts one watcher when the same resource is subscribed twice at once", async () => {
    const s = slowEvm();
    const ctx = await fakeCtx(s.routes);
    const subs = new Subscriptions(ctx, async () => undefined);
    const both = Promise.all([subs.subscribe(`stealth://coin/${A}`), subs.subscribe(`stealth://coin/${A}`)]);
    s.release();
    await both;
    await tick(60);
    const once = s.polls();
    subs.unsubscribe(`stealth://coin/${A}`);
    await tick(60);
    // nothing keeps polling after the one unsubscribe
    expect(s.polls()).toBe(once);
    expect(subs.uris).toEqual([]);
  });

  it("starts nothing when unsubscribed or closed while the coin is still being looked up", async () => {
    const s = slowEvm();
    const ctx = await fakeCtx(s.routes);
    const subs = new Subscriptions(ctx, async () => undefined);
    const p = subs.subscribe(`stealth://coin/${A}`);
    subs.unsubscribe(`stealth://coin/${A}`);
    const other = new Subscriptions(ctx, async () => undefined);
    const q = other.subscribe(`stealth://coin/${A}`);
    other.close();
    s.release();
    await Promise.allSettled([p, q]);
    await tick(60);
    expect(s.polls()).toBe(0);
    expect(subs.uris).toEqual([]);
    expect(other.uris).toEqual([]);
  });

  it("caps how many resources one session watches", async () => {
    const ctx = await fakeCtx({});
    const subs = new Subscriptions(ctx, async () => undefined, 2);
    await subs.subscribe("stealth://docs/fees");
    await expect(subs.subscribe("stealth://docs/no-such-page")).rejects.toMatchObject({ code: "not_found" });
    await subs.subscribe("stealth://docs/staking");
    await expect(subs.subscribe("stealth://docs/venues")).rejects.toMatchObject({ code: "too_many_subscriptions" });
    expect(subs.uris).toEqual(["stealth://docs/fees", "stealth://docs/staking"]);
    subs.close();
  });
});

describe("helpers", () => {
  it("parses stealth:// URIs", () => {
    expect(parseStealthUri(`stealth://coin/${MINT}`)).toEqual({ kind: "coin", address: MINT });
    expect(parseStealthUri("stealth://staking/stealth")).toEqual({ kind: "staking", pool: "stealth" });
    expect(parseStealthUri("stealth://chains")).toEqual({ kind: "static" });
    expect(parseStealthUri("stealth://coin/")).toBeNull();
    expect(parseStealthUri("http://coin/x")).toBeNull();
  });

  it("throttles to one call per window plus a trailing one", async () => {
    let calls = 0;
    const t = throttle(() => calls++, 50);
    t();
    t();
    t();
    expect(calls).toBe(1);
    await tick(80);
    expect(calls).toBe(2);
    t.cancel();
  });
});
