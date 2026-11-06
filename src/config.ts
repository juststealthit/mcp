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
import { stealthConfigDir } from "@juststealthit/sdk/keystore";
import { CHAINS, LIVE_CHAIN_KEYS, LIVE_EVM_CHAIN_KEYS, type ChainKey as AnyChainKey, type LiveChainKey, type LiveEvmChainKey } from "@juststealthit/sdk/utils";
import { z } from "zod";

/** Chains the platform runs coins on today, from the SDK's registry: Solana and the live EVM chains. */
export const CHAIN_KEYS = LIVE_CHAIN_KEYS as readonly LiveChainKey[] as readonly [LiveChainKey, ...LiveChainKey[]];
export type ChainKey = LiveChainKey;
export const EVM_CHAIN_KEYS = LIVE_EVM_CHAIN_KEYS as readonly LiveEvmChainKey[] as readonly [LiveEvmChainKey, ...LiveEvmChainKey[]];
export type EvmChain = LiveEvmChainKey;
export const isEvmChain = (c: string): c is EvmChain => (EVM_CHAIN_KEYS as readonly string[]).includes(c);
/** Every chain the registry knows, coming-soon ones included: what a tool accepts, so it can say a chain isn't open yet. */
export const ALL_CHAIN_KEYS = Object.keys(CHAINS) as AnyChainKey[] as [AnyChainKey, ...AnyChainKey[]];
export type { AnyChainKey };

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
  /** The default wallet's name, as the CLI sets it. */
  wallet: z.string().min(1).max(64).optional(),
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
  /** The default keystore wallet's name, shared with the CLI. */
  wallet: string | undefined;
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

/**
 * The config directory for this platform and environment, by the SDK's rule that the CLI follows too: `%APPDATA%\stealth` on Windows,
 * else an absolute `$XDG_CONFIG_HOME/stealth`, else `~/.config/stealth`. A 0.1 CLI folder that already holds the files is kept.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  return stealthConfigDir({ env, platform, home });
}

export function resolveConfig(file: ConfigFile = {}): ResolvedConfig {
  return {
    apiUrl: (file.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, ""),
    apiKey: file.apiKey,
    defaultChain: file.defaultChain ?? "solana",
    slippageBps: file.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    theme: file.theme,
    wallet: file.wallet,
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
