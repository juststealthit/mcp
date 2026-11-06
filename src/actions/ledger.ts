/**
 * The spend ledger behind the daily cap: `mcp-spend.json` in the config directory, mode 0600. Each signed action records what it
 * spends, so the rolling 24-hour cap holds across restarts.
 *
 * A spend is reserved before anything is signed and settled after. One that failed before it was sent is released; one whose fate is
 * unknown (sent, not confirmed in time) keeps counting, because it may still land.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

export const DAY_MS = 86_400_000;

const EntrySchema = z.object({
  id: z.string(),
  at: z.number(),
  lamports: z.string().regex(/^\d+$/),
  kind: z.string(),
  status: z.enum(["pending", "sent", "confirmed", "failed"]),
  signature: z.string().nullable(),
});
const FileSchema = z.object({ version: z.literal(1), entries: z.array(EntrySchema) });

export type SpendEntry = z.infer<typeof EntrySchema>;

export class SpendLedger {
  /** Serialises writes inside this process. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  static in(dir: string) {
    return new SpendLedger(path.join(dir, "mcp-spend.json"));
  }

  private async read(): Promise<SpendEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    const parsed = FileSchema.safeParse(json);
    // a damaged ledger must not reset the cap to zero: refuse to sign until it's fixed
    if (!parsed.success) throw new Error(`The spend ledger at ${this.file} is damaged. Fix or remove it to sign again.`);
    return parsed.data.entries;
  }

  private async write(entries: SpendEntry[]) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /**
   * Runs `fn` alone: queued behind this process's other writes, and holding a lock file against other processes, since two clients
   * can each start their own server over the same config directory. Without it, both could read the same total and both reserve.
   */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = () => withFileLock(`${this.file}.lock`, fn, this.now);
    const run = this.queue.then(guarded, guarded);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private live(entries: SpendEntry[]) {
    const since = this.now() - DAY_MS;
    return entries.filter((e) => e.at > since && e.status !== "failed");
  }

  /** Lamports spent or reserved in the last 24 hours. */
  async spentLastDay(): Promise<bigint> {
    return this.live(await this.read()).reduce((n, e) => n + BigInt(e.lamports), 0n);
  }

  /**
   * Reserves `lamports` if the rolling cap allows it, atomically with the check. Returns the entry id, or throws with what's left.
   */
  async reserve(lamports: bigint, kind: string, capPerDay: bigint): Promise<string> {
    return this.locked(async () => {
      const entries = this.live(await this.read());
      const spent = entries.reduce((n, e) => n + BigInt(e.lamports), 0n);
      if (spent + lamports > capPerDay) {
        const left = capPerDay > spent ? capPerDay - spent : 0n;
        throw new DailyCapError(spent, left);
      }
      const id = randomBytes(8).toString("hex");
      entries.push({ id, at: this.now(), lamports: lamports.toString(), kind, status: "pending", signature: null });
      await this.write(entries);
      return id;
    });
  }

  /** Records how a reserved spend ended. `failed` releases it. */
  async settle(id: string, status: SpendEntry["status"], signature: string | null = null): Promise<void> {
    await this.locked(async () => {
      const entries = this.live(await this.read());
      const e = entries.find((x) => x.id === id);
      if (!e) return;
      e.status = status;
      e.signature = signature;
      await this.write(entries);
    });
  }
}

/** A lock older than this is left over from a process that died holding it. */
export const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

/**
 * Holds `lockFile` (created exclusively) while `fn` runs. Waits for another holder up to 10 s, and takes over a lock older than
 * {@link LOCK_STALE_MS}. Gives up with an error rather than run unguarded.
 */
export async function withFileLock<T>(lockFile: string, fn: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  await mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const started = Date.now();
  let wait = 10;
  for (;;) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: now() }));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = await stat(lockFile).catch(() => null);
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockFile).catch(() => undefined);
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`The spend ledger is locked by another process (${lockFile}). If none is running, remove the lock file.`);
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 200);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockFile).catch(() => undefined);
  }
}

export class DailyCapError extends Error {
  constructor(
    readonly spentLamports: bigint,
    readonly leftLamports: bigint,
  ) {
    super("This would go over the daily signing cap.");
    this.name = "DailyCapError";
  }
}
