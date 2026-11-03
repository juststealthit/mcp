/**
 * The shared config directory, used by this server and by the Stealth CLI alike:
 *
 *   `$XDG_CONFIG_HOME/stealth`, else `~/.config/stealth`, and `%APPDATA%\stealth` on Windows.
 *
 * It holds `config.json` (read here) and `keystore.json` (see `keystore.ts`). Unknown keys in `config.json` are kept as they are, so a
 * newer CLI can add settings without this server rejecting the file.
 *
 * @module
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { DEFAULT_API_URL } from "@juststealthit/sdk";
import { z } from "zod";

/** Chains the platform runs coins on today. */
export const CHAIN_KEYS = ["solana", "robinhood", "bnb", "hyperevm", "base", "arc"] as const;
export type ChainKey = (typeof CHAIN_KEYS)[number];
export const EVM_CHAIN_KEYS = ["robinhood", "bnb", "hyperevm", "base", "arc"] as const;
export type EvmChain = (typeof EVM_CHAIN_KEYS)[number];
export const isEvmChain = (c: string): c is EvmChain => (EVM_CHAIN_KEYS as readonly string[]).includes(c);

/** Caps that apply when local signing is on and `config.json` doesn't set its own. */
export const DEFAULT_SIGNING_CAPS = { maxSolPerTx: 0.25, maxSolPerDay: 1 } as const;
export const DEFAULT_SLIPPAGE_BPS = 300;

export const McpSettingsSchema = z.looseObject({
  /** Turns local signing on without the `--allow-signing` flag. */
  allowSigning: z.boolean().optional(),
  /** The most SOL one signed transaction may spend. */
  maxSolPerTx: z.number().positive().max(1_000_000).optional(),
  /** The most SOL signed transactions may spend in a rolling 24 hours. */
  maxSolPerDay: z.number().positive().max(1_000_000).optional(),
});

export const ConfigFileSchema = z.looseObject({
  apiUrl: z.url().optional(),
  apiKey: z.string().min(1).optional(),
  defaultChain: z.enum(CHAIN_KEYS).optional(),
  slippageBps: z.number().int().min(10).max(5_000).optional(),
  theme: z.string().optional(),
  mcp: McpSettingsSchema.optional(),
});
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** The settings in force, after defaults. */
export interface ResolvedConfig {
  apiUrl: string;
  apiKey: string | undefined;
  defaultChain: ChainKey;
  slippageBps: number;
  theme: string | undefined;
  mcp: { allowSigning: boolean; maxSolPerTx: number; maxSolPerDay: number };
}

export interface LoadedConfig {
  dir: string;
  file: string;
  /** Whether `config.json` exists. */
  exists: boolean;
  /** Problems found in the file. A file with problems is ignored, and signing stays off. */
  problems: string[];
  config: ResolvedConfig;
}

/** The config directory for this platform and environment. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "win32") {
    const appData = env.APPDATA && path.win32.isAbsolute(env.APPDATA) ? env.APPDATA : path.win32.join(home, "AppData", "Roaming");
    return path.win32.join(appData, "stealth");
  }
  const xdg = env.XDG_CONFIG_HOME;
  // the XDG spec says a relative value is invalid and must be ignored
  const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, ".config");
  return path.posix.join(base, "stealth");
}

export function resolveConfig(file: ConfigFile = {}): ResolvedConfig {
  return {
    apiUrl: (file.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, ""),
    apiKey: file.apiKey,
    defaultChain: file.defaultChain ?? "solana",
    slippageBps: file.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    theme: file.theme,
    mcp: {
      allowSigning: file.mcp?.allowSigning ?? false,
      maxSolPerTx: file.mcp?.maxSolPerTx ?? DEFAULT_SIGNING_CAPS.maxSolPerTx,
      maxSolPerDay: file.mcp?.maxSolPerDay ?? DEFAULT_SIGNING_CAPS.maxSolPerDay,
    },
  };
}

/** Reads `config.json` from `dir`. A missing file is fine; a broken one is reported in `problems` and ignored. */
export async function loadConfig(dir: string = configDir()): Promise<LoadedConfig> {
  const file = path.join(dir, "config.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { dir, file, exists: false, problems: [], config: resolveConfig() };
    return { dir, file, exists: true, problems: [`Couldn't read ${path.basename(file)}: ${(error as Error).message}`], config: resolveConfig() };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { dir, file, exists: true, problems: [`${path.basename(file)} isn't valid JSON: ${(error as Error).message}`], config: resolveConfig() };
  }
  const parsed = ConfigFileSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { dir, file, exists: true, problems, config: resolveConfig() };
  }
  if (parsed.data.mcp?.maxSolPerTx !== undefined && parsed.data.mcp.maxSolPerDay !== undefined && parsed.data.mcp.maxSolPerTx > parsed.data.mcp.maxSolPerDay) {
    return { dir, file, exists: true, problems: ["mcp.maxSolPerTx is above mcp.maxSolPerDay."], config: resolveConfig() };
  }
  return { dir, file, exists: true, problems: [], config: resolveConfig(parsed.data) };
}
