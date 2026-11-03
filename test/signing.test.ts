import { createPublicKey, verify } from "node:crypto";

import { decodeTransaction } from "@juststealthit/sdk/solana";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";

import type { LocalSigner } from "../src/actions/signing.js";
import { MINT, call, callError, cosignedLegacyTx, harness, solToken, swapTx, tempDir, testSigner, type Harness } from "./helpers.js";

let h: Harness | null = null;
let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  await cleanup?.();
  cleanup = null;
});

const SIG = "5".repeat(88);
const quote = (amountIn: string) => ({ venue: "curve", side: "buy", amountIn, amountOut: "5000000000", minAmountOut: "4850000000", feeLamports: "1", feeBps: 225, priceImpactPct: 0.5 });

/** A server with local signing on, over a fake API that records what was sent. */
async function signingHarness(opts: { caps?: { maxSolPerTx: number; maxSolPerDay: number }; elicit?: boolean | "decline"; requireElicitation?: boolean } = {}) {
  const t = await tempDir();
  cleanup = t.cleanup;
  const s = await testSigner(t.dir, opts.caps ?? { maxSolPerTx: 0.5, maxSolPerDay: 1 }, opts.requireElicitation);
  const sent: string[] = [];
  const messages: string[] = [];
  const owner = s.keypair.publicKey;
  h = await harness({
    context: { signer: s.signer as LocalSigner, configDir: t.dir },
    capabilities: opts.elicit === false || opts.elicit === undefined ? {} : { elicitation: {} },
    elicit: (m) => {
      messages.push(m);
      return opts.elicit === "decline" ? { action: "decline" } : { action: "accept", content: { confirm: true } };
    },
    routes: {
      [`GET /sol/tokens/${MINT}`]: solToken(),
      "POST /sol/swap": (c: { body: { amount: string; owner: string } }) => ({ transaction: swapTx(new PublicKey(c.body.owner)), quote: quote(c.body.amount), lastValidBlockHeight: 1 }),
      "POST /sol/send": (c: { body: { transaction: string } }) => {
        sent.push(c.body.transaction);
        return { signature: SIG };
      },
      [`GET /sol/tx/${SIG}`]: { status: "confirmed", error: null },
      "GET /staking": { enabled: true, pools: [{ id: "stealth", name: "$STEALTH", symbol: "STEALTH", receiptSymbol: "stSTEALTH", mint: MINT, receiptMint: MINT, decimals: 6, aprBps: 1000, boosts: [], cooldownSec: 21_600, depositLamports: 0, minAmount: "1", totalStaked: "0", stakers: 0, rewardPool: "0" }] },
      "POST /staking/stealth/stake": () => ({ actionId: 9, transaction: cosignedLegacyTx(owner, stakingWallet), depositLamports: 0, escrow: "e" }),
      "POST /staking/actions/9/submit": (c: { body: { transaction: string } }) => {
        sent.push(c.body.transaction);
        return { signature: SIG, status: "confirmed" };
      },
    },
  });
  return { ...s, sent, messages, dir: t.dir };
}
const stakingWallet = Keypair.generate();

describe("local signing", () => {
  it("prepares with a preparedId, asks the user, signs with the keystore wallet and sends", async () => {
    const s = await signingHarness({ elicit: true });
    const prep = await call<{ preparedId: string; wallet: string }>(h!, "prepare_buy", { address: MINT, amount: "0.1" });
    expect(prep.wallet).toBe(s.wallet.address);
    expect(prep.preparedId).toMatch(/^prep_/);
    const r = await call<Record<string, any>>(h!, "sign_and_send", { preparedId: prep.preparedId });
    expect(r).toMatchObject({ status: "confirmed", signatures: [SIG], spentSol: "0.1", spentLast24hSol: "0.1", dailyCapSol: 1 });
    expect(s.messages[0]).toMatch(/Buy TEST on Solana/);
    expect(s.messages[0]).toMatch(/can't be undone/);
    // what went out carries a valid signature by the keystore wallet over the exact message
    const tx = decodeTransaction(s.sent[0]!) as VersionedTransaction;
    const spki = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), s.keypair.publicKey.toBuffer()]), format: "der", type: "spki" });
    expect(verify(null, Buffer.from(tx.message.serialize()), spki, Buffer.from(tx.signatures[0]!))).toBe(true);
    // a prepared action is used once
    expect((await callError(h!, "sign_and_send", { preparedId: prep.preparedId })).error?.code).toBe("unknown_or_expired");
  });

  it("sends nothing when the user declines", async () => {
    const s = await signingHarness({ elicit: "decline" });
    const prep = await call<{ preparedId: string }>(h!, "prepare_buy", { address: MINT, amount: "0.1" });
    const r = await call<{ status: string; signatures: string[] }>(h!, "sign_and_send", { preparedId: prep.preparedId });
    expect(r).toMatchObject({ status: "declined", signatures: [] });
    expect(s.sent).toEqual([]);
  });

  it("refuses above the per-transaction cap before asking anyone", async () => {
    const s = await signingHarness({ elicit: true, caps: { maxSolPerTx: 0.05, maxSolPerDay: 1 } });
    const prep = await call<{ preparedId: string }>(h!, "prepare_buy", { address: MINT, amount: "0.1" });
    const e = await callError(h!, "sign_and_send", { preparedId: prep.preparedId });
    expect(e.error?.code).toBe("over_tx_cap");
    expect(s.messages).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  it("enforces the rolling daily cap across actions", async () => {
    const s = await signingHarness({ elicit: true, caps: { maxSolPerTx: 0.5, maxSolPerDay: 0.6 } });
    const a = await call<{ preparedId: string }>(h!, "prepare_buy", { address: MINT, amount: "0.4" });
    await call(h!, "sign_and_send", { preparedId: a.preparedId });
    const b = await call<{ preparedId: string }>(h!, "prepare_buy", { address: MINT, amount: "0.3" });
    const e = await callError(h!, "sign_and_send", { preparedId: b.preparedId });
    expect(e.error?.code).toBe("over_daily_cap");
    expect(e.text).toMatch(/0\.2 SOL is left/);
    expect(s.sent).toHaveLength(1);
  });

  it("refuses a client that can't confirm when confirmation is required", async () => {
    const s = await signingHarness({ elicit: false, requireElicitation: true });
    const prep = await call<{ preparedId: string }>(h!, "prepare_buy", { address: MINT, amount: "0.1" });
    expect((await callError(h!, "sign_and_send", { preparedId: prep.preparedId })).error?.code).toBe("confirmation_unavailable");
    expect(s.sent).toEqual([]);
  });

  it("gives no preparedId for another wallet, and won't sign one", async () => {
    await signingHarness({ elicit: true });
    const other = Keypair.generate().publicKey.toBase58();
    const r = await call<{ preparedId: string | null; nextSteps: string[] }>(h!, "prepare_buy", { address: MINT, amount: "0.1", wallet: other });
    expect(r.preparedId).toBeNull();
    expect(r.nextSteps.join(" ")).toMatch(new RegExp(other));
  });

  it("signs a staking action exactly as the staking wallet co-signed it", async () => {
    const s = await signingHarness({ elicit: true });
    const prep = await call<{ preparedId: string }>(h!, "prepare_stake", { amount: "10" });
    const r = await call<{ status: string }>(h!, "sign_and_send", { preparedId: prep.preparedId });
    expect(r.status).toBe("confirmed");
    const tx = decodeTransaction(s.sent[0]!);
    // the staking wallet's signature is kept, and the owner's is added
    const legacy = tx as unknown as { signatures: { publicKey: PublicKey; signature: Buffer | null }[] };
    expect(legacy.signatures.map((x) => x.publicKey.toBase58()).sort()).toEqual([s.wallet.address, stakingWallet.publicKey.toBase58()].sort());
    expect(legacy.signatures.every((x) => x.signature !== null)).toBe(true);
  });

  it("reports its mode, wallet, caps and spend", async () => {
    const s = await signingHarness({ elicit: true });
    expect(await call(h!, "get_signing_status")).toMatchObject({ mode: "local-signing", wallet: { address: s.wallet.address }, caps: { maxSolPerTx: 0.5, maxSolPerDay: 1 }, spentLast24hSol: "0", clientCanConfirm: true });
  });
});
