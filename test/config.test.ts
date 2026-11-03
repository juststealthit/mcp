import { writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SIGNING_CAPS, configDir, loadConfig, resolveConfig } from "../src/config.js";
import { tempDir } from "./helpers.js";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("configDir", () => {
  it("uses XDG_CONFIG_HOME when it's absolute", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x/cfg" }, "linux", "/home/u")).toBe("/x/cfg/stealth");
  });
  it("ignores a relative XDG_CONFIG_HOME, as the spec says", () => {
    expect(configDir({ XDG_CONFIG_HOME: "relative" }, "linux", "/home/u")).toBe("/home/u/.config/stealth");
  });
  it("falls back to ~/.config on macOS and Linux", () => {
    expect(configDir({}, "darwin", "/Users/u")).toBe("/Users/u/.config/stealth");
  });
  it("uses %APPDATA% on Windows", () => {
    expect(configDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Roaming\\stealth");
    expect(configDir({}, "win32", "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Roaming\\stealth");
  });
});

describe("loadConfig", () => {
  it("defaults when there is no file", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const c = await loadConfig(t.dir);
    expect(c.exists).toBe(false);
    expect(c.problems).toEqual([]);
    expect(c.config.apiUrl).toBe("https://juststealthit.xyz/api");
    expect(c.config.defaultChain).toBe("solana");
    expect(c.config.slippageBps).toBe(300);
    expect(c.config.mcp).toEqual({ allowSigning: false, ...DEFAULT_SIGNING_CAPS });
  });

  it("reads the shared fields and the mcp block, and keeps unknown keys out of the way", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    await writeFile(
      path.join(t.dir, "config.json"),
      JSON.stringify({ apiUrl: "https://staging.example/api/", defaultChain: "base", slippageBps: 150, theme: "dark", futureKey: { a: 1 }, mcp: { allowSigning: true, maxSolPerTx: 0.1, maxSolPerDay: 0.5 } }),
    );
    const c = await loadConfig(t.dir);
    expect(c.problems).toEqual([]);
    expect(c.config).toMatchObject({ apiUrl: "https://staging.example/api", defaultChain: "base", slippageBps: 150, theme: "dark", mcp: { allowSigning: true, maxSolPerTx: 0.1, maxSolPerDay: 0.5 } });
  });

  it("reports broken JSON and falls back to defaults", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    await writeFile(path.join(t.dir, "config.json"), "{ nope");
    const c = await loadConfig(t.dir);
    expect(c.problems[0]).toMatch(/isn't valid JSON/);
    expect(c.config.mcp.allowSigning).toBe(false);
  });

  it("reports schema problems with their path", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    await writeFile(path.join(t.dir, "config.json"), JSON.stringify({ slippageBps: 99_999, mcp: { maxSolPerTx: -1 } }));
    const c = await loadConfig(t.dir);
    expect(c.problems.some((p) => p.startsWith("slippageBps"))).toBe(true);
    expect(c.problems.some((p) => p.startsWith("mcp.maxSolPerTx"))).toBe(true);
  });

  it("refuses a per-transaction cap above the daily cap", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    await writeFile(path.join(t.dir, "config.json"), JSON.stringify({ mcp: { maxSolPerTx: 2, maxSolPerDay: 1 } }));
    expect((await loadConfig(t.dir)).problems).toEqual(["mcp.maxSolPerTx is above mcp.maxSolPerDay."]);
  });

  it("strips a trailing slash from apiUrl", () => {
    expect(resolveConfig({ apiUrl: "http://localhost:3000/api//" }).apiUrl).toBe("http://localhost:3000/api");
  });
});
