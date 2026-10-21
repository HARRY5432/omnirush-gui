// tsc emits only TypeScript: every plain-JavaScript module under src (the ones shared with the CLI in
// src/workspace, src/computer-use/shared and src/provider-lock, see PARITY.sha256 there, and the server's own,
// such as src/box/retention.mjs) is copied into dist as it is, at the same path. Every .mjs under src is
// copied (tests aside), so a new folder needs no list here; the build fails if any did not arrive.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = join(root, "src");
const dist = join(root, "dist");

function plainModules(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...plainModules(full));
    else if (entry.isFile() && entry.name.endsWith(".mjs") && !/\.test\.mjs$/.test(entry.name)) found.push(full);
  }
  return found;
}

const copied = [];
for (const file of plainModules(src)) {
  const target = join(dist, relative(src, file));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
  copied.push(relative(src, file));
}
const missing = copied.filter((name) => !existsSync(join(dist, name)));
if (missing.length) {
  process.stderr.write(`copy-shared-modules: not in dist: ${missing.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ copied })}\n`);
