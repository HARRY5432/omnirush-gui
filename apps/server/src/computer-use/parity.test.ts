// The shared computer-use modules are the same files in omnirush-cli
// (src/computer-use/) and here; PARITY.sha256 lists their hashes in both
// repositories, so a change in one shows up here until it is ported.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dir, "shared");

describe("CLI/desktop parity: computer use", () => {
  test("shared/PARITY.sha256 matches its files and lists every shared file", () => {
    const rows = readFileSync(path.join(dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
    const listed = rows.map((row) => row.split(/\s+/)[1]);
    expect(listed.sort()).toEqual(readdirSync(dir).filter((name) => name !== "PARITY.sha256").sort());
    for (const row of rows) {
      const [hash, name] = row.split(/\s+/);
      const actual = createHash("sha256").update(readFileSync(path.join(dir, name ?? ""))).digest("hex");
      expect(`${name} ${actual}`).toBe(`${name} ${hash}`);
    }
  });

  test("shared modules import only node: built-ins and each other", () => {
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".mjs"))) {
      const source = readFileSync(path.join(dir, name), "utf8");
      for (const match of source.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)) {
        const spec = match[1] ?? "";
        expect(spec.startsWith("node:") || spec.startsWith("./") || (name === "native-worker.mjs" && spec === "koffi")).toBe(true);
      }
      expect(source).not.toMatch(/from\s+["']electron["']/);
    }
  });
});
