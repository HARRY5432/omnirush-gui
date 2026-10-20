// tsc does not emit the plain-JS MCP allowlist module (src/mcp-allow/mcp-allow.mjs,
// shared with the OmniRush CLI as is): copy it beside the compiled server so
// dist/mcp-allow/state.js can import it.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(process.argv[2] ?? join(root, "dist"), "mcp-allow");
mkdirSync(outdir, { recursive: true });
for (const name of ["mcp-allow.mjs", "mcp-allow.d.mts"]) copyFileSync(join(root, "src", "mcp-allow", name), join(outdir, name));
process.stdout.write(`${JSON.stringify({ copied: outdir })}\n`);
