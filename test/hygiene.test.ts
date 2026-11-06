/**
 * Guards for a public repository: what ships says only what it should, and never logs to stdout.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StealthApiError } from "@juststealthit/sdk";
import { describe, expect, it } from "vitest";

import { RefusedError, describeError, errorOf, toolError, toMcpError } from "../src/errors.js";
import { Logger, redact, routeConsoleToLogger } from "../src/logger.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".git", "coverage"].includes(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|mjs|js|json|md)$/.test(name) && name !== "package-lock.json") out.push(p);
  }
  return out;
}

describe("repository hygiene", () => {
  const all = files(root);

  it("uses only the Stealth brand", () => {
    const old = ["MK" + "RZ", "Mar" + "keter", "Fla" + "re", "Ston" + "ka", "hood" + "wink"];
    for (const f of all) {
      const text = readFileSync(f, "utf8");
      for (const word of old) expect(new RegExp(`\\b${word}\\b`, "i").test(text), `${path.relative(root, f)} mentions ${word}`).toBe(false);
    }
  });

  it("names no assistant as an author or a tool used to write it", () => {
    const words = ["Clau" + "de", "Anthro" + "pic", "Chat" + "GPT", "Co" + "pilot"];
    const allowedIn = new Set(["README.md"]); // install snippets may name the clients users run
    for (const f of all) {
      if (allowedIn.has(path.basename(f))) continue;
      const text = readFileSync(f, "utf8");
      for (const w of words) expect(text.includes(w), `${path.relative(root, f)} mentions ${w}`).toBe(false);
    }
  });

  it("keeps machine paths and secrets out", () => {
    for (const f of all) {
      const text = readFileSync(f, "utf8");
      // a real home directory (test fixtures use one-letter users such as /Users/u)
      expect(/\/Users\/[A-Za-z][\w.-]+\/|\/home\/[A-Za-z][\w.-]+\/|C:\\Users\\[A-Za-z][\w.-]+\\/.test(text), path.relative(root, f)).toBe(false);
      expect(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), path.relative(root, f)).toBe(false);
    }
  });

  it("never writes to stdout from the server's source", () => {
    for (const f of all.filter((x) => x.includes(`${path.sep}src${path.sep}`))) {
      const text = readFileSync(f, "utf8");
      const lines = text.split("\n").filter((l) => /console\.(log|info|debug)|process\.stdout\.write/.test(l));
      // the CLI may print --help and --version, which run instead of the server
      const ok = lines.every((l) => f.endsWith("cli.ts") && /HELP|VERSION/.test(l));
      expect(ok, `${path.relative(root, f)}: ${lines.join(" | ")}`).toBe(true);
    }
  });
});

describe("logging and errors", () => {
  it("redacts credential-like keys at any depth", () => {
    expect(redact({ a: 1, apiKey: "k", nested: { passphrase: "p", list: [{ authorization: "Bearer x" }] } })).toEqual({ a: 1, apiKey: "[redacted]", nested: { passphrase: "[redacted]", list: [{ authorization: "[redacted]" }] } });
  });

  it("writes only to the stream it was given, never stdout", () => {
    const lines: string[] = [];
    const original = process.stdout.write;
    let stdout = 0;
    process.stdout.write = (() => {
      stdout++;
      return true;
    }) as never;
    try {
      const l = new Logger({ level: "debug", write: (x) => lines.push(x) });
      l.info("hello", { token: "t" });
      l.debug("details");
    } finally {
      process.stdout.write = original;
    }
    expect(stdout).toBe(0);
    expect(lines[0]).toMatch(/info {4}hello {"token":"\[redacted\]"}/);
    expect(lines).toHaveLength(2);
  });

  it("sends a dependency's console output to the logger, never to stdout", () => {
    const lines: string[] = [];
    const original = process.stdout.write;
    let stdout = 0;
    process.stdout.write = (() => {
      stdout++;
      return true;
    }) as never;
    const undo = routeConsoleToLogger(new Logger({ level: "debug", write: (x) => lines.push(x) }));
    try {
      const c = console as unknown as Record<string, (...a: unknown[]) => void>;
      c["log"]!("from a dependency", { n: 1 });
      c["debug"]!("quiet detail");
    } finally {
      undo();
      process.stdout.write = original;
    }
    expect(stdout).toBe(0);
    expect(lines[0]).toMatch(/info {4}from a dependency \{ n: 1 \}/);
    expect(lines[1]).toMatch(/debug {3}quiet detail/);
  });

  it("maps errors to stable codes, for tools and for JSON-RPC", () => {
    const api = new StealthApiError(429, "rate_limited", "slow down", [], 3, { method: "GET", url: "u", requestId: "r1", attempt: 3 });
    expect(describeError(api)).toMatchObject({ code: "rate_limited", retryable: true, retryAfterSec: 3, requestId: "r1" });
    const t = toolError(new RefusedError("over_tx_cap", "too much"));
    expect(t.isError).toBe(true);
    expect(t.structuredContent).toBeUndefined();
    expect(errorOf(t)).toEqual({ code: "over_tx_cap", message: "too much", retryable: false });
    expect(JSON.parse((t.content[1] as { text: string }).text)).toEqual({ error: { code: "over_tx_cap", message: "too much", retryable: false } });
    expect(toMcpError(new StealthApiError(404, "not_found", "nope")).code).toBe(-32002);
    expect(toMcpError(new RangeError("bad")).code).toBe(-32602);
  });
});
