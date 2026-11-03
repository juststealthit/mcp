/**
 * The shared keystore, `keystore.json` in the config directory, written by the Stealth CLI and read here:
 *
 * ```json
 * { "version": 1, "wallets": [{ "name": "main", "kind": "solana", "address": "…",
 *   "crypto": { "kdf": "scrypt", "kdfparams": { "n": 131072, "r": 8, "p": 1, "salt": "<hex>" },
 *               "cipher": "aes-256-gcm", "iv": "<hex>", "tag": "<hex>", "ciphertext": "<hex>" } }] }
 * ```
 *
 * The key is `scrypt(passphrase, salt, 32)` and the secret is AES-256-GCM. Every decrypted key is checked against the wallet's
 * `address` before it is used, so a wrong file, a wrong passphrase or a corrupt entry can never sign as somebody else.
 *
 * Addresses are public and can be read without the passphrase. Only signing needs it.
 *
 * @module
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { Keypair } from "@solana/web3.js";
import { isEvmAddress, isSolanaAddress } from "@juststealthit/sdk/utils";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { bytesToHex } from "viem";
import { z } from "zod";

const hex = (min: number, max = 4096) =>
  z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]*$/, "must be hex")
    .refine((s) => s.replace(/^0x/, "").length % 2 === 0, "must be whole bytes")
    .refine((s) => {
      const n = s.replace(/^0x/, "").length / 2;
      return n >= min && n <= max;
    }, `must be ${min} to ${max} bytes`);

export const KDF_DEFAULTS = { n: 131_072, r: 8, p: 1 } as const;

export const WalletCryptoSchema = z.object({
  kdf: z.literal("scrypt"),
  kdfparams: z.object({
    n: z
      .number()
      .int()
      .min(2 ** 14)
      .max(2 ** 20)
      .refine((n) => (n & (n - 1)) === 0, "n must be a power of two"),
    r: z.number().int().min(1).max(32),
    p: z.number().int().min(1).max(16),
    salt: hex(16, 64),
  }),
  cipher: z.literal("aes-256-gcm"),
  iv: hex(12, 16),
  tag: hex(16, 16),
  ciphertext: hex(16),
});

export const KeystoreWalletSchema = z.object({
  name: z.string().min(1).max(64),
  kind: z.enum(["solana", "evm"]),
  address: z.string().min(1),
  crypto: WalletCryptoSchema,
});

export const KeystoreFileSchema = z.object({
  version: z.literal(1),
  wallets: z.array(KeystoreWalletSchema),
});

export type KeystoreWallet = z.infer<typeof KeystoreWalletSchema>;
export type KeystoreFile = z.infer<typeof KeystoreFileSchema>;
export type WalletCrypto = z.infer<typeof WalletCryptoSchema>;

export class KeystoreError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid" | "wrong_passphrase" | "address_mismatch" | "unsupported",
  ) {
    super(message);
    this.name = "KeystoreError";
  }
}

export interface LoadedKeystore {
  file: string;
  wallets: KeystoreWallet[];
  /** File-mode problems worth telling the user about, such as a keystore others can read. */
  warnings: string[];
}

const fromHex = (s: string) => Buffer.from(s.replace(/^0x/, ""), "hex");

function scrypt(passphrase: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  // scrypt needs 128 × n × r bytes; leave headroom over Node's 32 MB default
  const opts: ScryptOptions = { N: n, r, p, maxmem: 128 * n * r * 2 + 16 * 1024 * 1024 };
  return new Promise((resolve, reject) => scryptCb(passphrase, salt, 32, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** Reads and validates `keystore.json` in `dir`. Throws a {@link KeystoreError} with `not_found` if there isn't one. */
export async function readKeystore(dir: string): Promise<LoadedKeystore> {
  const file = path.join(dir, "keystore.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new KeystoreError(`No keystore at ${file}.`, "not_found");
    throw new KeystoreError(`Couldn't read the keystore: ${(error as Error).message}`, "invalid");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new KeystoreError("The keystore isn't valid JSON.", "invalid");
  }
  const parsed = KeystoreFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new KeystoreError(`The keystore doesn't match version 1: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "invalid");
  }
  const warnings: string[] = [];
  if (process.platform !== "win32") {
    const mode = (await stat(file)).mode & 0o777;
    if (mode & 0o077) warnings.push(`The keystore is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 "${file}"`);
  }
  for (const w of parsed.data.wallets) {
    const ok = w.kind === "solana" ? isSolanaAddress(w.address) : isEvmAddress(w.address) || /^0x[0-9a-fA-F]{40}$/.test(w.address);
    if (!ok) throw new KeystoreError(`Wallet "${w.name}" has an address that isn't a ${w.kind} address.`, "invalid");
  }
  const names = new Set<string>();
  for (const w of parsed.data.wallets) {
    if (names.has(w.name)) throw new KeystoreError(`Two wallets are named "${w.name}".`, "invalid");
    names.add(w.name);
  }
  return { file, wallets: parsed.data.wallets, warnings };
}

/** Picks a wallet by name, or the first of `kind`. */
export function pickWallet(wallets: KeystoreWallet[], kind: "solana" | "evm", name?: string): KeystoreWallet | null {
  if (name) {
    const w = wallets.find((x) => x.name === name);
    if (!w) return null;
    if (w.kind !== kind) throw new KeystoreError(`Wallet "${name}" is a ${w.kind} wallet, not ${kind}.`, "unsupported");
    return w;
  }
  return wallets.find((w) => w.kind === kind) ?? null;
}

/** Decrypts a wallet's secret. A wrong passphrase fails the GCM tag check and throws `wrong_passphrase`. */
export async function decryptSecret(crypto: WalletCrypto, passphrase: string): Promise<Buffer> {
  const { n, r, p, salt } = crypto.kdfparams;
  const key = await scrypt(passphrase, fromHex(salt), n, r, p);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, fromHex(crypto.iv));
    decipher.setAuthTag(fromHex(crypto.tag));
    return Buffer.concat([decipher.update(fromHex(crypto.ciphertext)), decipher.final()]);
  } catch {
    throw new KeystoreError("Wrong passphrase, or the keystore entry is damaged.", "wrong_passphrase");
  } finally {
    key.fill(0);
  }
}

/**
 * Encrypts `secret` the way the keystore stores it. The server never writes a keystore; this exists so tests and tools build entries
 * byte-for-byte the way the reader expects.
 */
export async function encryptSecret(secret: Uint8Array, passphrase: string, params: { n?: number; r?: number; p?: number } = {}): Promise<WalletCrypto> {
  const n = params.n ?? KDF_DEFAULTS.n;
  const r = params.r ?? KDF_DEFAULTS.r;
  const p = params.p ?? KDF_DEFAULTS.p;
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = await scrypt(passphrase, salt, n, r, p);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    return {
      kdf: "scrypt",
      kdfparams: { n, r, p, salt: salt.toString("hex") },
      cipher: "aes-256-gcm",
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    };
  } finally {
    key.fill(0);
  }
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const v = BASE58.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * The raw key bytes inside a decrypted secret. Raw bytes are the canonical form; a text secret (a JSON byte array as Solana's tools
 * write it, base58, or hex) is accepted too, so a keystore made from an exported key still works.
 */
export function secretBytes(plain: Uint8Array): Uint8Array {
  if (plain.length === 32 || plain.length === 64) {
    // could still be text that happens to be 32 or 64 bytes long: only treat it as text if it is printable and decodes
    const asText = printable(plain) ? decodeText(Buffer.from(plain).toString("utf8")) : null;
    return asText ?? plain;
  }
  const text = Buffer.from(plain).toString("utf8").trim();
  const decoded = decodeText(text);
  if (!decoded) throw new KeystoreError("The decrypted secret isn't a key this server understands.", "unsupported");
  return decoded;
}

const printable = (b: Uint8Array) => b.every((c) => c >= 0x20 && c < 0x7f);

function decodeText(text: string): Uint8Array | null {
  const t = text.trim();
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t) as unknown;
      if (Array.isArray(arr) && arr.every((x) => Number.isInteger(x) && x >= 0 && x < 256) && (arr.length === 32 || arr.length === 64)) return Uint8Array.from(arr as number[]);
    } catch {
      return null;
    }
    return null;
  }
  const h = t.replace(/^0x/, "");
  if (/^[0-9a-fA-F]+$/.test(h) && (h.length === 64 || h.length === 128)) return Uint8Array.from(Buffer.from(h, "hex"));
  const b = base58Decode(t);
  if (b && (b.length === 32 || b.length === 64)) return b;
  return null;
}

/** A Solana keypair from a decrypted secret: a 64-byte secret key or a 32-byte seed. Checked against `expectedAddress`. */
export function solanaKeypairFrom(plain: Uint8Array, expectedAddress: string): Keypair {
  // a copy: Keypair keeps a reference to what it's given, and the caller wipes the plaintext afterwards
  const bytes = Uint8Array.from(secretBytes(plain));
  let kp: Keypair;
  try {
    kp = bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes);
  } catch {
    throw new KeystoreError("The decrypted secret isn't a valid Solana key.", "unsupported");
  }
  if (kp.publicKey.toBase58() !== expectedAddress) throw new KeystoreError("The decrypted key doesn't match the wallet's address.", "address_mismatch");
  return kp;
}

/** An EVM account from a decrypted 32-byte private key. Checked against `expectedAddress`, case-insensitively. */
export function evmAccountFrom(plain: Uint8Array, expectedAddress: string): PrivateKeyAccount {
  const bytes = secretBytes(plain);
  if (bytes.length !== 32) throw new KeystoreError("An EVM wallet's secret must be a 32-byte private key.", "unsupported");
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(bytesToHex(bytes));
  } catch {
    throw new KeystoreError("The decrypted secret isn't a valid EVM key.", "unsupported");
  }
  if (account.address.toLowerCase() !== expectedAddress.toLowerCase()) throw new KeystoreError("The decrypted key doesn't match the wallet's address.", "address_mismatch");
  return account;
}

/** Decrypts a Solana wallet and checks it. The plaintext buffer is wiped once the keypair holds the key. */
export async function unlockSolanaWallet(wallet: KeystoreWallet, passphrase: string): Promise<Keypair> {
  if (wallet.kind !== "solana") throw new KeystoreError(`Wallet "${wallet.name}" isn't a Solana wallet.`, "unsupported");
  const plain = await decryptSecret(wallet.crypto, passphrase);
  try {
    return solanaKeypairFrom(plain, wallet.address);
  } finally {
    plain.fill(0);
  }
}
