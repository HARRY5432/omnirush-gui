import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { START_RESET_PENDING, applyPendingStartReset, scheduleStartReset, startResetTargets } from "./start-reset.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "start-reset-"));
  const userDataPath = path.join(root, "ai.omnirush.desktop");
  const configDir = path.join(root, "omnirush-config");
  await mkdir(path.join(userDataPath, "engine-data", "omnirush"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(userDataPath, "omnirush-workspaces.json"), "{\"workspaces\":[]}");
  await writeFile(path.join(userDataPath, "engine-data", "omnirush", "opencode.db"), "db");
  await writeFile(path.join(userDataPath, "omnirush-account.bin"), "signed in");
  await writeFile(path.join(configDir, "server.json"), "{}");
  await writeFile(path.join(configDir, "runtime.sqlite"), "sqlite");
  await writeFile(path.join(configDir, "env.json"), "{}");
  const env = { OMNIRUSH_SERVER_CONFIG: path.join(configDir, "server.json") };
  const targets = startResetTargets({ userDataPath, env, homedir: root });
  return { root, userDataPath, configDir, targets };
}

test("targets are the app's start state, never sign-in or the user's env", async () => {
  const { userDataPath, configDir, targets } = await fixture();
  const paths = targets.map((target) => target.path);
  assert.ok(paths.includes(path.join(userDataPath, "engine-data")));
  assert.ok(paths.includes(path.join(userDataPath, "omnirush-workspaces.json")));
  assert.ok(paths.includes(path.join(configDir, "server.json")));
  assert.ok(paths.includes(path.join(configDir, "runtime.sqlite")));
  assert.ok(!paths.some((entry) => /omnirush-account|env\.json|private-credentials/.test(entry)));
});

test("nothing happens without a request", async () => {
  const { userDataPath, targets } = await fixture();
  assert.deepEqual(await applyPendingStartReset({ userDataPath, targets }), { ran: false, moved: [], failed: [] });
  assert.ok(existsSync(path.join(userDataPath, "omnirush-workspaces.json")));
});

test("a requested reset moves the start state into a backup folder on the next launch", async () => {
  const { userDataPath, configDir, targets } = await fixture();
  await scheduleStartReset({ userDataPath, now: () => new Date("2026-10-17T10:00:00Z") });
  assert.ok(existsSync(path.join(userDataPath, START_RESET_PENDING)));
  const result = await applyPendingStartReset({ userDataPath, targets, now: () => new Date("2026-10-17T10:00:05Z") });
  assert.equal(result.ran, true);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(new Set(result.moved), new Set([
    "app/omnirush-workspaces.json", "app/engine-data", "config/server.json", "config/runtime.sqlite",
  ]));
  const backup = path.join(userDataPath, "start-reset-20261017-100005");
  assert.equal(result.backupDir, backup);
  assert.equal(await readFile(path.join(backup, "app", "engine-data", "omnirush", "opencode.db"), "utf8"), "db");
  assert.equal(await readFile(path.join(backup, "config", "server.json"), "utf8"), "{}");
  assert.ok(!existsSync(path.join(userDataPath, "engine-data")));
  assert.ok(!existsSync(path.join(configDir, "server.json")));
  // Sign-in and the user's env stay; the request is consumed.
  assert.ok(existsSync(path.join(userDataPath, "omnirush-account.bin")));
  assert.ok(existsSync(path.join(configDir, "env.json")));
  assert.ok(!existsSync(path.join(userDataPath, START_RESET_PENDING)));
  assert.deepEqual(JSON.parse(await readFile(path.join(backup, "reset.json"), "utf8")).failed, []);
  assert.equal((await applyPendingStartReset({ userDataPath, targets })).ran, false);
});

test("a move across drives falls back to a rename beside the file; a locked file is reported, not fatal", async () => {
  const { userDataPath, configDir, targets } = await fixture();
  await scheduleStartReset({ userDataPath });
  const calls = [];
  const renameImpl = async (from, to) => {
    calls.push([from, to]);
    if (from.endsWith("runtime.sqlite")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    if (from.startsWith(configDir) && to.startsWith(userDataPath)) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const { rename } = await import("node:fs/promises");
    return rename(from, to);
  };
  const result = await applyPendingStartReset({ userDataPath, targets, renameImpl, now: () => new Date("2026-10-17T11:00:00Z") });
  assert.deepEqual(result.failed, [{ label: "config/runtime.sqlite", code: "EBUSY" }]);
  assert.ok(result.moved.includes("config/server.json"));
  assert.ok((await readdir(configDir)).includes("server.json.omnirush-reset-20261017-110000"));
  assert.ok(existsSync(path.join(configDir, "runtime.sqlite")));
});
