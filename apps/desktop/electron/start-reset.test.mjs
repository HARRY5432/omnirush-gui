import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  START_RESET_PENDING,
  START_RESTORE_PENDING,
  applyPendingStartReset,
  applyPendingStartRestore,
  scheduleStartReset,
  scheduleStartRestore,
  startResetTargets,
} from "./start-reset.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "start-reset-"));
  const userDataPath = path.join(root, "ai.omnirush.desktop");
  const configDir = path.join(root, "omnirush-config");
  await mkdir(path.join(userDataPath, "engine-data", "omnirush"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(userDataPath, "omnirush-workspaces.json"), "{\"workspaces\":[\"old\"]}");
  await writeFile(path.join(userDataPath, "engine-data", "omnirush", "opencode.db"), "chats");
  await writeFile(path.join(userDataPath, "omnirush-account.bin"), "signed in");
  await writeFile(path.join(configDir, "server.json"), "{}");
  await writeFile(path.join(configDir, "runtime.sqlite"), "sqlite");
  await writeFile(path.join(configDir, "runtime.sqlite-wal"), "wal");
  await writeFile(path.join(configDir, "runtime.sqlite-journal"), "journal");
  await writeFile(path.join(configDir, "runtime.sqlite-shm"), "shm");
  await writeFile(path.join(configDir, "env.json"), "{}");
  const env = { OMNIRUSH_SERVER_CONFIG: path.join(configDir, "server.json") };
  const targetsFor = ({ includeEngineData }) => startResetTargets({ userDataPath, env, homedir: root, includeEngineData });
  return { root, userDataPath, configDir, targetsFor };
}

const at = (iso) => () => new Date(iso);

test("targets: start state only; engine data only when asked; the runtime database with its -wal/-shm as one group", async () => {
  const { userDataPath, configDir, targetsFor } = await fixture();
  const plain = targetsFor({ includeEngineData: false });
  const all = plain.flatMap((target) => target.paths);
  assert.ok(all.includes(path.join(userDataPath, "omnirush-workspaces.json")));
  assert.ok(all.includes(path.join(configDir, "server.json")));
  assert.ok(!all.some((entry) => /engine-data|omnirush-account|env\.json|private-credentials/.test(entry)));
  assert.deepEqual(plain.find((target) => target.label === "config/runtime.sqlite").paths.map((entry) => path.basename(entry)),
    ["runtime.sqlite", "runtime.sqlite-journal", "runtime.sqlite-wal", "runtime.sqlite-shm"]);
  assert.ok(targetsFor({ includeEngineData: true }).some((target) => target.label === "app/engine-data"));
});

test("nothing happens without a request", async () => {
  const { userDataPath, targetsFor } = await fixture();
  assert.deepEqual(await applyPendingStartReset({ userDataPath, targetsFor }), { ran: false, moved: [], failed: [] });
  assert.ok(existsSync(path.join(userDataPath, "omnirush-workspaces.json")));
});

test("a reset moves the start state into the announced backup folder and keeps chats, sign-in and env", async () => {
  const { userDataPath, configDir, targetsFor } = await fixture();
  const { backupDir } = await scheduleStartReset({ userDataPath, now: at("2026-10-17T10:00:00Z") });
  assert.equal(backupDir, path.join(userDataPath, "start-reset-20261017-100000"));
  const result = await applyPendingStartReset({ userDataPath, targetsFor, now: at("2026-10-17T10:00:09Z") });
  assert.equal(result.backupDir, backupDir);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(new Set(result.moved), new Set(["app/omnirush-workspaces.json", "config/server.json", "config/runtime.sqlite"]));
  assert.equal(await readFile(path.join(backupDir, "config", "runtime.sqlite-wal"), "utf8"), "wal");
  assert.equal(await readFile(path.join(backupDir, "config", "runtime.sqlite-journal"), "utf8"), "journal");
  assert.ok(!existsSync(path.join(configDir, "runtime.sqlite-journal")));
  assert.ok(!existsSync(path.join(configDir, "runtime.sqlite")));
  assert.equal(await readFile(path.join(userDataPath, "engine-data", "omnirush", "opencode.db"), "utf8"), "chats");
  assert.ok(existsSync(path.join(userDataPath, "omnirush-account.bin")));
  assert.ok(existsSync(path.join(configDir, "env.json")));
  assert.ok(!existsSync(path.join(userDataPath, START_RESET_PENDING)));
});

test("engine data moves only when the reset asked for it (a failed engine store)", async () => {
  const { userDataPath, targetsFor } = await fixture();
  const { backupDir } = await scheduleStartReset({ userDataPath, includeEngineData: true });
  const result = await applyPendingStartReset({ userDataPath, targetsFor });
  assert.ok(result.moved.includes("app/engine-data"));
  assert.equal(await readFile(path.join(backupDir, "app", "engine-data", "omnirush", "opencode.db"), "utf8"), "chats");
});

test("the runtime database group moves all together or not at all", async () => {
  const { userDataPath, configDir, targetsFor } = await fixture();
  await scheduleStartReset({ userDataPath });
  const renameImpl = async (from, to) => {
    if (from.endsWith("runtime.sqlite-shm")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return rename(from, to);
  };
  const result = await applyPendingStartReset({ userDataPath, targetsFor, renameImpl });
  assert.deepEqual(result.failed, [{ label: "config/runtime.sqlite", code: "EBUSY" }]);
  for (const name of ["runtime.sqlite", "runtime.sqlite-wal", "runtime.sqlite-shm"]) {
    assert.ok(existsSync(path.join(configDir, name)), `${name} stays with its group`);
  }
  assert.ok(result.moved.includes("config/server.json"));
});

test("across drives a group moves beside itself", async () => {
  const { userDataPath, configDir, targetsFor } = await fixture();
  await scheduleStartReset({ userDataPath });
  const renameImpl = async (from, to) => {
    if (from.startsWith(configDir) && to.startsWith(userDataPath)) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    return rename(from, to);
  };
  const result = await applyPendingStartReset({ userDataPath, targetsFor, renameImpl, now: at("2026-10-17T11:00:00Z") });
  assert.deepEqual(result.failed, []);
  const names = await readdir(configDir);
  assert.ok(names.includes("server.json.omnirush-reset-20261017-110000"));
  assert.ok(names.includes("runtime.sqlite-wal.omnirush-reset-20261017-110000"));
});

test("Restore previous app data moves the backup back and keeps what the fresh start made", async () => {
  const { userDataPath, configDir, targetsFor } = await fixture();
  const { backupDir } = await scheduleStartReset({ userDataPath });
  await applyPendingStartReset({ userDataPath, targetsFor });
  // The fresh start wrote new files.
  await writeFile(path.join(userDataPath, "omnirush-workspaces.json"), "{\"workspaces\":[\"fresh\"]}");
  await writeFile(path.join(configDir, "runtime.sqlite"), "fresh");

  await scheduleStartRestore({ userDataPath, backupDir });
  const result = await applyPendingStartRestore({ userDataPath, now: at("2026-10-17T12:00:00Z") });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(new Set(result.restored), new Set(["app/omnirush-workspaces.json", "config/server.json", "config/runtime.sqlite"]));
  assert.equal(await readFile(path.join(userDataPath, "omnirush-workspaces.json"), "utf8"), "{\"workspaces\":[\"old\"]}");
  assert.equal(await readFile(path.join(configDir, "runtime.sqlite"), "utf8"), "sqlite");
  assert.equal(await readFile(path.join(configDir, "runtime.sqlite-shm"), "utf8"), "shm");
  const replaced = path.join(backupDir, "replaced-20261017-120000");
  assert.equal(await readFile(path.join(replaced, "app", "omnirush-workspaces.json"), "utf8"), "{\"workspaces\":[\"fresh\"]}");
  assert.equal(await readFile(path.join(replaced, "config", "runtime.sqlite"), "utf8"), "fresh");
  assert.ok(!existsSync(path.join(userDataPath, START_RESTORE_PENDING)));
  assert.equal((await applyPendingStartRestore({ userDataPath })).ran, false);
});

test("a restore outside the app's folder or without a receipt changes nothing", async () => {
  const { root, userDataPath } = await fixture();
  await scheduleStartRestore({ userDataPath, backupDir: path.join(root, "elsewhere") });
  const result = await applyPendingStartRestore({ userDataPath });
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.failed, [{ label: "receipt", code: "missing" }]);
});
