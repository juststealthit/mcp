/**
 * The shared keystore, `keystore.json` in the config directory, written by the Stealth CLI and read here:
 *
 * ```json
 * { "version": 1, "wallets": [{ "name": "main", "kind": "solana", "address": "…",
 *   "crypto": { "kdf": "scrypt", "kdfparams": { "n": 131072, "r": 8, "p": 1, "salt": "<hex>" },
 *               "cipher": "aes-256-gcm", "iv": "<hex>", "tag": "<hex>", "ciphertext": "<hex>" } }] }
 * ```
 *
 * The format and its code live in the SDK (`@juststealthit/sdk/keystore`), so this server and the CLI read and check a file the
 * same way. This server only reads it: addresses without the passphrase, and one Solana wallet unlocked for signing when the user
 * turns that on. Every decrypted key is checked against the wallet's `address` before it is used, and an entry sealed with a scrypt
 * cost below `KDF_MIN_N` (2^14) is refused.
 *
 * @module
 */
import { KeystoreError, findWallet, type KeystoreWallet, type WalletKind } from "@juststealthit/sdk/keystore";

export {
  KDF_DEFAULTS,
  KDF_MIN_N,
  KeystoreError,
  decryptSecret,
  encryptSecret,
  evmAccountFrom,
  parseKeystore,
  readKeystore,
  secretBytes,
  solanaKeypairFrom,
  unlockSolanaWallet,
  type CryptoBlock as WalletCrypto,
  type Keystore as KeystoreFile,
  type KeystoreErrorCode,
  type KeystoreWallet,
  type LoadedKeystore,
} from "@juststealthit/sdk/keystore";

/**
 * Picks a wallet by name, or the first of `kind`. `null` when there's none; a named wallet of the other kind throws `unsupported`.
 */
export function pickWallet(wallets: readonly KeystoreWallet[], kind: WalletKind, name?: string): KeystoreWallet | null {
  if (name) {
    const w = findWallet(wallets, name);
    if (!w) return null;
    if (w.kind !== kind) throw new KeystoreError(`Wallet "${name}" is a ${w.kind} wallet, not ${kind}.`, "unsupported");
    return w;
  }
  return wallets.find((w) => w.kind === kind) ?? null;
}
