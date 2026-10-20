// @ts-nocheck -- drives the session uploader with loosely typed fakes, as capture-context.test.ts does.
import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { permissionSetupSettings } from "./approval-mode.js";
import * as uploader from "./session-uploader.js";

const hasZstd = typeof zlib.zstdDecompressSync === "function";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `omnirush-permset-${prefix}-`));
}

test("permissionSetupSettings: Careful and Normal are named, Auto and unknown add nothing", () => {
  assert.deepEqual(permissionSetupSettings("careful"), { permission_mode: "careful" });
  assert.deepEqual(permissionSetupSettings("guarded"), { permission_mode: "normal" });
  assert.deepEqual(permissionSetupSettings("full"), {});
  assert.deepEqual(permissionSetupSettings(null), {});
  assert.deepEqual(permissionSetupSettings(undefined), {});
});

/** The setup settings a session's context.environment records with the app in `mode`. */
async function setupSettings(mode) {
  const root = tmp("root");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const stateDir = tmp("state");
  // The engine config the app writes: its permission rules stay in the record.
  fs.writeFileSync(path.join(stateDir, "runtime-opencode-config.json"), JSON.stringify({ permission: { bash: { "*": "allow", "rm -rf *": "ask" } } }));
  const envelopes = [];
  const syncer = new uploader.SessionUploader({
    stateDir,
    fallbackScanMs: 60_000,
    capabilities: async () => ({ schema_versions: [2], canonical_trace: false }),
    upload: async (_sessionId, compressed) => {
      envelopes.push(JSON.parse(zlib.zstdDecompressSync(Buffer.from(compressed)).toString("utf8")));
      return new Response("{}", { status: 201 });
    },
    context: {
      sections: { system_packages: false, services: false, pm_config: false, shell_aliases: false, processes: false },
      sampler: null,
      network: false,
      ephemeral: { registryFallback: false },
      env: {},
    },
  });
  if (mode !== undefined) syncer.setPermissionMode(mode);
  const sessionId = "01a0dcd2-d8ee-7222-80eb-2400637704a1";
  syncer.startSession(sessionId, "ws", root);
  syncer.captureSnapshot(sessionId, "prompt");
  syncer.captureSnapshot(sessionId, "turn_completed");
  await syncer.context?.settled(sessionId, 30_000);
  syncer.finishSession(sessionId);
  await syncer.idle(sessionId);
  await syncer.stop();
  const events = [];
  for (const envelope of envelopes) {
    const file = (envelope.files ?? []).find((entry) => entry.path === "__omnirush__/trace.json");
    events.push(...(file ? JSON.parse(file.content).events ?? [] : envelope.trace ?? []));
  }
  const environment = events.find((event) => event.type === "context.environment");
  assert.ok(environment, "a context.environment event");
  return environment.data.setup.settings;
}

test.skipIf(!hasZstd)("setup record: names the permission mode next to the unchanged engine settings", async () => {
  const normal = await setupSettings("guarded");
  assert.equal(normal.permission_mode, "normal");
  assert.deepEqual(normal.permission, { bash: { "*": "allow", "rm -rf *": "ask" } });
  assert.equal((await setupSettings("careful")).permission_mode, "careful");
  const auto = await setupSettings("full");
  assert.equal("permission_mode" in auto, false);
  assert.deepEqual(auto.permission, { bash: { "*": "allow", "rm -rf *": "ask" } });
  assert.equal("permission_mode" in (await setupSettings(undefined)), false);
}, 60_000);
