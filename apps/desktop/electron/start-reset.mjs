/**
 * "Reset app data" on the couldn't-start screen: the app's local start
 * state (workspace list, embedded server registry and runtime database,
 * engine data, port and token state) is moved into a backup folder, never
 * deleted, and the app restarts with a fresh state. Sign-in, Chromium
 * storage, the user's own config files and env.json stay.
 *
 * The move happens on the next launch, before anything opens those files
 * (Windows cannot rename a folder a running engine or database holds), so
 * the request only writes a marker and relaunches.
 */
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { omnirushConfigDir } from "@omnirush/paths";

export const START_RESET_PENDING = ".start-reset-pending.json";
export const START_RESET_BACKUP_PREFIX = "start-reset-";

const USERDATA_ENTRIES = [
  "omnirush-workspaces.json",
  "workspace-state.json",
  "omnirush-server-tokens.json",
  "omnirush-server-state.json",
  "engine-data",
  "managed-opencode-workdir",
];
const CONFIG_ENTRIES = [
  "server.json",
  "runtime.sqlite",
  "runtime.sqlite-wal",
  "runtime.sqlite-shm",
  "runtime-opencode-config.json",
  "engine-instances.json",
];

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

/** What a reset moves: `{ label, path }`, the label naming it inside the backup. */
export function startResetTargets({ userDataPath, env = process.env, homedir, platform = process.platform }) {
  const configDir = omnirushConfigDir({ env, homeDir: homedir, platform });
  return [
    ...USERDATA_ENTRIES.map((name) => ({ label: `app/${name}`, path: path.join(userDataPath, name) })),
    ...CONFIG_ENTRIES.map((name) => ({ label: `config/${name}`, path: path.join(configDir, name) })),
  ];
}

/** Ask for a reset on the next launch. */
export async function scheduleStartReset({ userDataPath, now = () => new Date() }) {
  await mkdir(userDataPath, { recursive: true });
  await writeFile(
    path.join(userDataPath, START_RESET_PENDING),
    `${JSON.stringify({ requestedAt: now().toISOString() })}\n`,
    { mode: 0o600 },
  );
}

/**
 * On launch: when a reset was asked for, move every target that exists into
 * `<userData>/start-reset-<time>/` (or, across drives, beside itself with a
 * `.omnirush-reset-<time>` suffix). Never throws; returns what moved.
 */
export async function applyPendingStartReset({ userDataPath, targets, now = () => new Date(), renameImpl = rename, log = () => {} }) {
  const marker = path.join(userDataPath, START_RESET_PENDING);
  if (!existsSync(marker)) return { ran: false, moved: [], failed: [] };
  const time = stamp(now());
  const backupDir = path.join(userDataPath, `${START_RESET_BACKUP_PREFIX}${time}`);
  const moved = [];
  const failed = [];
  try {
    await mkdir(backupDir, { recursive: true });
  } catch (error) {
    log(`[start-reset] backup folder unavailable (${error?.code ?? "error"})`);
  }
  for (const target of targets) {
    if (!existsSync(target.path)) continue;
    const destination = path.join(backupDir, ...target.label.split("/"));
    try {
      await mkdir(path.dirname(destination), { recursive: true });
      await renameImpl(target.path, destination);
      moved.push(target.label);
    } catch (error) {
      try {
        await renameImpl(target.path, `${target.path}.omnirush-reset-${time}`);
        moved.push(target.label);
      } catch (fallbackError) {
        failed.push({ label: target.label, code: fallbackError?.code ?? error?.code ?? "error" });
      }
    }
  }
  await writeFile(
    path.join(backupDir, "reset.json"),
    `${JSON.stringify({ resetAt: now().toISOString(), moved, failed }, null, 2)}\n`,
  ).catch(() => undefined);
  await rm(marker, { force: true }).catch(() => undefined);
  log(`[start-reset] moved ${moved.length} item(s) aside${failed.length ? `, ${failed.length} could not be moved` : ""}`);
  return { ran: true, backupDir, moved, failed };
}

