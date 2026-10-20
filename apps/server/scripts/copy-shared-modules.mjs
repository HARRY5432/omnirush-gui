// tsc emits only TypeScript: the plain-JavaScript modules shared with the CLI
// (src/workspace/*.mjs, see PARITY.sha256 there) are copied into dist as they are.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const copied = [];
for (const folder of ["workspace"]) {
  const from = join(root, "src", folder);
  const to = join(root, "dist", folder);
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).filter((file) => file.endsWith(".mjs"))) {
    copyFileSync(join(from, name), join(to, name));
    copied.push(join(folder, name));
  }
}
process.stdout.write(`${JSON.stringify({ copied })}\n`);
