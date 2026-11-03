import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DAY_MS, DailyCapError, SpendLedger } from "../src/actions/ledger.js";
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
  const action = { kind: "buy" as const, chain: "solana" as const, owner: "o", summary: "s", spendLamports: 1n, feeBps: null, maxFeeBps: null, transactions: [], bundle: false, stakingActionId: null, mint: null };

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
