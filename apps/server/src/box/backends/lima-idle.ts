// Ported from the CLI (omnirush-cli src/box/backends/lima-idle.js); keep the two
// in step. The sandbox VM's idle watcher (lima.ts keepIdleWatch starts it,
// detached; Desktop: with the app's own binary as node, ELECTRON_RUN_AS_NODE=1):
//   lima-idle.js <box home> <limactl> <vm name>
// Once a minute: while a live lease is there (a running box of any app, the
// CLI's too) the VM is busy; after setup.darwin.vm.idle_stop_min with none, it
// stops the VM under the owner lock and ends. It ends too when the VM is
// stopped by someone else, or another watcher took over (idle.json names
// another pid: the CLI's watcher and this one never run side by side).
import { readFileSync } from "node:fs";
import path from "node:path";

import { idleStep, idleStopMinutes, limaDir, stopIfIdle } from "./lima.js";

const [home = "", bin = "", instance = ""] = process.argv.slice(2);
const runtime = { home, bin, instance };
const idleMs = idleStopMinutes() * 60_000;
const tickMs = Math.max(1_000, Math.min(60_000, Math.floor(idleMs / 5) || 60_000));
const mine = (): boolean => {
  try { return Number(JSON.parse(readFileSync(path.join(limaDir(home), "idle.json"), "utf8")).pid) === process.pid; } catch { return false; }
};

let busyAt = Date.now();
if (!home || !bin || !instance || idleMs <= 0) process.exit(0);
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, tickMs));
  if (!mine()) process.exit(0);
  const step = await idleStep(runtime, { busyAt, idleMs }).catch(() => ({ busyAt, stop: undefined, done: undefined }));
  if (step.done) process.exit(0);
  busyAt = step.busyAt;
  if (step.stop) {
    const done = await stopIfIdle(runtime).catch(() => ({ stopped: false, reason: undefined }));
    if (done.stopped) process.exit(0);
    if (done.reason === "busy") busyAt = Date.now();
  }
}
