import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Keypair } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";

import {
  KDF_DEFAULTS,
  KeystoreError,
  decryptSecret,
  encryptSecret,
  evmAccountFrom,
  pickWallet,
  readKeystore,
  solanaKeypairFrom,
  unlockSolanaWallet,
  type KeystoreWallet,
} from "../src/keystore.js";
import { tempDir, testWallet, writeKeystore } from "./helpers.js";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

const FAST = { n: 2 ** 14 };

describe("encryption", () => {
  it("writes exactly the shared format, with the default scrypt cost", async () => {
    const c = await encryptSecret(new Uint8Array(64).fill(7), "pw");
    expect(c.kdf).toBe("scrypt");
    expect(c.cipher).toBe("aes-256-gcm");
    expect(c.kdfparams).toMatchObject({ n: KDF_DEFAULTS.n, r: 8, p: 1 });
    expect(c.kdfparams.n).toBe(131_072);
    expect(c.kdfparams.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(c.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(c.tag).toMatch(/^[0-9a-f]{32}$/);
    expect(c.ciphertext).toMatch(/^[0-9a-f]{128}$/);
    expect(Buffer.from(await decryptSecret(c, "pw"))).toEqual(Buffer.alloc(64, 7));
  });

  it("refuses a wrong passphrase", async () => {
    const c = await encryptSecret(new Uint8Array(32), "right", FAST);
    await expect(decryptSecret(c, "wrong")).rejects.toMatchObject({ code: "wrong_passphrase" });
  });

  it("refuses a tampered ciphertext", async () => {
    const c = await encryptSecret(new Uint8Array(32).fill(1), "pw", FAST);
    const flipped = (parseInt(c.ciphertext.slice(0, 2), 16) ^ 1).toString(16).padStart(2, "0");
    await expect(decryptSecret({ ...c, ciphertext: flipped + c.ciphertext.slice(2) }, "pw")).rejects.toBeInstanceOf(KeystoreError);
  });
});

describe("key forms", () => {
  const kp = Keypair.generate();
  const address = kp.publicKey.toBase58();

  it("accepts a 64-byte Solana secret key", async () => {
    expect((await solanaKeypairFrom(kp.secretKey, address)).publicKey.toBase58()).toBe(address);
  });
  it("accepts a 32-byte seed", async () => {
    expect((await solanaKeypairFrom(kp.secretKey.slice(0, 32), address)).publicKey.toBase58()).toBe(address);
  });
  it("accepts the JSON byte array Solana's tools write", async () => {
    const text = new TextEncoder().encode(JSON.stringify([...kp.secretKey]));
    expect((await solanaKeypairFrom(text, address)).publicKey.toBase58()).toBe(address);
  });
  it("refuses a key that doesn't match the address", async () => {
    await expect(solanaKeypairFrom(Keypair.generate().secretKey, address)).rejects.toThrow(/doesn't match/);
  });
  it("reads an EVM private key, raw or as hex text, and checks its address", async () => {
    const pk = generatePrivateKey();
    const addr = privateKeyToAccount(pk).address;
    expect((await evmAccountFrom(Buffer.from(pk.slice(2), "hex"), addr.toLowerCase())).address).toBe(addr);
    expect((await evmAccountFrom(new TextEncoder().encode(pk), addr)).address).toBe(addr);
    await expect(evmAccountFrom(Buffer.from(pk.slice(2), "hex"), "0x0000000000000000000000000000000000000001")).rejects.toThrow(/doesn't match/);
  });
});

describe("readKeystore", () => {
  it("reads wallets and unlocks a Solana one", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const w = await testWallet("main");
    await writeKeystore(t.dir, [w.wallet]);
    const ks = await readKeystore(t.dir);
    expect(ks.warnings).toEqual([]);
    expect(ks.wallets.map((x) => x.name)).toEqual(["main"]);
    const unlocked = await unlockSolanaWallet(pickWallet(ks.wallets, "solana")!, w.passphrase);
    expect(unlocked.publicKey.toBase58()).toBe(w.wallet.address);
  });

  it("warns when others can read the file", async () => {
    if (process.platform === "win32") return;
    const t = await tempDir();
    cleanup = t.cleanup;
    await writeKeystore(t.dir, [(await testWallet()).wallet], 0o644);
    expect((await readKeystore(t.dir)).warnings[0]).toMatch(/readable by other users/);
  });

  it("says when there is none", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    await expect(readKeystore(t.dir)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects a file that isn't version 1", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    await writeFile(path.join(t.dir, "keystore.json"), JSON.stringify({ version: 2, wallets: [] }));
    await expect(readKeystore(t.dir)).rejects.toMatchObject({ code: "bad_keystore" });
  });

  it("rejects weak scrypt parameters", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const w = await testWallet();
    const weak: KeystoreWallet = { ...w.wallet, crypto: { ...w.wallet.crypto, kdfparams: { ...w.wallet.crypto.kdfparams, n: 1024 } } };
    await writeKeystore(t.dir, [weak]);
    await expect(readKeystore(t.dir)).rejects.toMatchObject({ code: "bad_keystore" });
  });

  it("rejects a wallet whose address isn't of its kind", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    const w = await testWallet();
    await writeKeystore(t.dir, [{ ...w.wallet, address: "0x0000000000000000000000000000000000000001" }]);
    await expect(readKeystore(t.dir)).rejects.toMatchObject({ code: "bad_keystore" });
  });

  it("picks by name, and refuses the wrong kind", async () => {
    const a = await testWallet("a");
    const evm: KeystoreWallet = { ...a.wallet, name: "e", kind: "evm", address: "0x0000000000000000000000000000000000000001" };
    expect(pickWallet([evm, a.wallet], "solana")?.name).toBe("a");
    expect(pickWallet([evm, a.wallet], "solana", "missing")).toBeNull();
    expect(() => pickWallet([evm, a.wallet], "solana", "e")).toThrow(/evm wallet/);
  });
});
