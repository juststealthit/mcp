import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DAY_MS, DailyCapError, LOCK_STALE_MS, SpendLedger } from "../src/actions/ledger.js";
import { PreparedStore } from "../src/actions/prepared.js";
import { tempDir } from "./helpers.js";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("SpendLedger", () => {
  it("reserves under the cap and refuses over it, saying what's left", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const l = SpendLedger.in(t.dir);
    await l.reserve(600n, "buy", 1_000n);
    await expect(l.reserve(500n, "buy", 1_000n)).rejects.toSatisfy((e: unknown) => e instanceof DailyCapError && e.leftLamports === 400n);
    await l.reserve(400n, "buy", 1_000n);
    expect(await l.spentLastDay()).toBe(1_000n);
  });

  it("holds the cap across two servers sharing one config dir", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    // two ledgers over one file stand for two server processes: each has its own in-process queue
    const a = SpendLedger.in(t.dir);
    const b = SpendLedger.in(t.dir);
    const results = await Promise.allSettled([a.reserve(600n, "buy", 1_000n), b.reserve(600n, "buy", 1_000n), a.reserve(600n, "buy", 1_000n), b.reserve(600n, "buy", 1_000n)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await a.spentLastDay()).toBe(600n);
    await expect(stat(path.join(t.dir, "mcp-spend.json.lock"))).rejects.toThrow();
  });

  it("takes over a lock left behind by a process that died", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const lock = path.join(t.dir, "mcp-spend.json.lock");
    await writeFile(lock, "{}");
    const old = new Date(Date.now() - LOCK_STALE_MS - 5_000);
    await utimes(lock, old, old);
    await SpendLedger.in(t.dir).reserve(1n, "buy", 10n);
    expect(await SpendLedger.in(t.dir).spentLastDay()).toBe(1n);
  });

  it("refuses a damaged ledger instead of starting from zero", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    await writeFile(path.join(t.dir, "mcp-spend.json"), "{ not json");
    await expect(SpendLedger.in(t.dir).reserve(1n, "buy", 10n)).rejects.toThrow(/damaged/);
  });

  it("releases a spend that failed before landing", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const l = SpendLedger.in(t.dir);
    const id = await l.reserve(900n, "buy", 1_000n);
    await l.settle(id, "failed");
    expect(await l.spentLastDay()).toBe(0n);
  });

  it("counts a rolling 24 hours", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    let now = 1_000_000_000_000;
    const l = new SpendLedger(path.join(t.dir, "mcp-spend.json"), () => now);
    await l.reserve(1_000n, "buy", 1_000n);
    now += DAY_MS - 1;
    await expect(l.reserve(1n, "buy", 1_000n)).rejects.toBeInstanceOf(DailyCapError);
    now += 2;
    await l.reserve(1_000n, "buy", 1_000n);
  });

  it("serialises concurrent reservations so the cap holds", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const l = SpendLedger.in(t.dir);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => l.reserve(300n, "buy", 1_000n)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  });

  it("writes a private file, and refuses to go on with a damaged one", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const l = SpendLedger.in(t.dir);
    await l.reserve(1n, "buy", 10n);
    if (process.platform !== "win32") expect((await stat(l.file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(l.file, "utf8")).version).toBe(1);
    await writeFile(l.file, JSON.stringify({ version: 1, entries: [{ nope: true }] }));
    await expect(l.spentLastDay()).rejects.toThrow(/damaged/);
  });
});

describe("PreparedStore", () => {
  const action = { kind: "buy" as const, chain: "solana" as const, owner: "o", summary: "s", spendLamports: 1n, feeBps: null, maxFeeBps: null, transactions: [], bundle: false, stakingActionId: null, mint: null, page: null };

  it("hands an action out once", () => {
    const s = new PreparedStore();
    const p = s.put(action);
    expect(p.id).toMatch(/^prep_/);
    expect(s.take(p.id)?.id).toBe(p.id);
    expect(s.take(p.id)).toBeNull();
  });

  it("expires actions", () => {
    let now = 0;
    const s = new PreparedStore(1_000, () => now);
    const p = s.put(action);
    now = 999;
    expect(s.peek(p.id)).not.toBeNull();
    now = 1_000;
    expect(s.peek(p.id)).toBeNull();
  });
});
