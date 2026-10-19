/**
 * The project archive's state per account. A sign-out keeps what the
 * account has not sent yet (its queued archives and the records of its
 * chains). The next start under another account sets that state aside
 * under `accounts/<key>/`, where nothing sends it, and brings back that
 * account's own. A sign-in to the account that left it takes it back
 * as it was. State set aside for longer than PARKED_MAX_AGE_MS is deleted.
 *
 * `<archive dir>/account.json` ({v: 1, account_id}) names the account the
 * state in place belongs to. The hash cache, the key and the temp folder
 * are not per account and stay.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ACCOUNT_FILE = "account.json";
export const PARKED_DIRECTORY = "accounts";
/** State another account left is kept this long for it, then deleted. */
export const PARKED_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
/** The folders of the archive state that belong to one account. */
export const ACCOUNT_SCOPED_DIRECTORIES = ["sessions", "baselines", "queue", "pending", "touched", "files-used", "attachments"] as const;

/** The folder name of an account's state set aside (never the id itself). */
export function parkedKey(account: string): string {
  return createHash("sha256").update(account, "utf8").digest("hex").slice(0, 32);
}

async function readAccountFile(path: string): Promise<{ account: string | null; parkedAt: number | null }> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object") return { account: null, parkedAt: null };
    const account = Reflect.get(value, "account_id");
    const parkedAt = Date.parse(String(Reflect.get(value, "parked_at") ?? ""));
    return { account: typeof account === "string" && account ? account : null, parkedAt: Number.isFinite(parkedAt) ? parkedAt : null };
  } catch {
    return { account: null, parkedAt: null };
  }
}

/** The account the archive state in place belongs to; null when none is recorded. */
export async function archiveOwner(dir: string): Promise<string | null> {
  return (await readAccountFile(join(dir, ACCOUNT_FILE))).account;
}

export async function setArchiveOwner(dir: string, account: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, ACCOUNT_FILE);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify({ v: 1, account_id: account }), { mode: 0o600 });
  await rename(temporary, path);
}

/** Moves every entry of `from` into `to` (an entry moved replaces one of the same name there). */
async function moveEntries(from: string, to: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(from);
  } catch {
    return 0;
  }
  if (names.length === 0) return 0;
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of names) {
    const target = join(to, name);
    await rm(target, { recursive: true, force: true });
    await rename(join(from, name), target);
  }
  return names.length;
}

/** Sets the state in place aside for `account` (merged into what it already has aside); nothing is deleted. */
export async function parkAccountState(dir: string, account: string, now = Date.now()): Promise<number> {
  const parked = join(dir, PARKED_DIRECTORY, parkedKey(account));
  let moved = 0;
  for (const name of ACCOUNT_SCOPED_DIRECTORIES) moved += await moveEntries(join(dir, name), join(parked, name));
  await mkdir(parked, { recursive: true, mode: 0o700 });
  await writeFile(join(parked, ACCOUNT_FILE), JSON.stringify({ v: 1, account_id: account, parked_at: new Date(now).toISOString() }), { mode: 0o600 });
  await rm(join(dir, ACCOUNT_FILE), { force: true });
  return moved;
}

/** Brings back what `account` has aside (merged into the state in place); false when it has nothing. */
export async function restoreAccountState(dir: string, account: string): Promise<boolean> {
  const parked = join(dir, PARKED_DIRECTORY, parkedKey(account));
  if (!(await stat(parked).then(() => true, () => false))) return false;
  if ((await readAccountFile(join(parked, ACCOUNT_FILE))).account !== account) return false;
  for (const name of ACCOUNT_SCOPED_DIRECTORIES) await moveEntries(join(parked, name), join(dir, name));
  await rm(parked, { recursive: true, force: true });
  return true;
}

/** Deletes state set aside longer than `maxAgeMs` ago (or unreadable and as old); returns how many. */
export async function pruneParked(dir: string, now = Date.now(), maxAgeMs = PARKED_MAX_AGE_MS): Promise<number> {
  const root = join(dir, PARKED_DIRECTORY);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let pruned = 0;
  for (const name of names) {
    const path = join(root, name);
    const { parkedAt } = await readAccountFile(join(path, ACCOUNT_FILE));
    const at = parkedAt ?? (await stat(path).then((info) => info.mtimeMs, () => now));
    if (now - at > maxAgeMs) {
      await rm(path, { recursive: true, force: true });
      pruned += 1;
    }
  }
  return pruned;
}

/**
 * At a start under `account`: another account's state in place is set
 * aside for it, `account`'s own comes back, and old state set aside goes.
 * `parked`: the account whose state was set aside (null: none).
 */
export async function claimArchiveState(dir: string, account: string, now = Date.now()): Promise<{ parked: string | null; restored: boolean; pruned: number }> {
  const owner = await archiveOwner(dir);
  let parked: string | null = null;
  if (owner && owner !== account) {
    await parkAccountState(dir, owner, now);
    parked = owner;
  }
  const restored = await restoreAccountState(dir, account);
  await setArchiveOwner(dir, account);
  const pruned = await pruneParked(dir, now);
  return { parked, restored, pruned };
}
