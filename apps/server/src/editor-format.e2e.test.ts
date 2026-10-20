import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { formatterFor, projectFormatters, runFormatter } from "./routes/editor-format.js";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function project(withPrettier: boolean) {
  const root = await mkdtemp(join(tmpdir(), "omnirush-format-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "x", private: true, devDependencies: withPrettier ? { prettier: "3" } : {} }));
  return root;
}

/** This repository's own Prettier, linked into a test project (none on this machine: the test is skipped). */
function repoPrettier(): string | null {
  try {
    return dirname(createRequire(import.meta.url).resolve("prettier/package.json"));
  } catch {
    // pnpm keeps it under the workspace root's .pnpm folder.
    const store = join(import.meta.dir, "..", "..", "..", "node_modules", ".pnpm");
    const entry = existsSync(store) ? readdirSync(store).find((name) => name.startsWith("prettier@")) : undefined;
    return entry ? join(store, entry, "node_modules", "prettier") : null;
  }
}

test("no formatter set up: none is used (never a built-in one)", async () => {
  const root = await project(false);
  expect(formatterFor(root, join(root, "src/a.ts"))).toBeNull();
  expect(formatterFor(root, join(root, "src/a.go"), { PATH: "" })).toBeNull();
  expect(projectFormatters(root, { PATH: "" })).toEqual([]);
});

test("the project's Prettier formats the text it is given and writes nothing", async () => {
  const prettier = repoPrettier();
  if (!prettier) return;
  const root = await project(true);
  await mkdir(join(root, "node_modules"), { recursive: true });
  await symlink(prettier, join(root, "node_modules", "prettier"), "dir");
  const formatter = formatterFor(root, join(root, "src/a.ts"));
  if (!formatter) return; // no node on PATH here
  expect(formatter.name).toBe("Prettier");
  const out = await runFormatter(formatter, root, "export   const   messy={a:1,b:[1,2,3]}\n");
  expect(out).toBe("export const messy = { a: 1, b: [1, 2, 3] };\n");
  expect(existsSync(join(root, "src/a.ts"))).toBe(false);
  expect(projectFormatters(root)).toContain("Prettier");
});

test("a formatter that rejects the text is an error, not an empty file", async () => {
  const prettier = repoPrettier();
  if (!prettier) return;
  const root = await project(true);
  await mkdir(join(root, "node_modules"), { recursive: true });
  await symlink(prettier, join(root, "node_modules", "prettier"), "dir");
  const formatter = formatterFor(root, join(root, "src/a.ts"));
  if (!formatter) return;
  await expect(runFormatter(formatter, root, "export const = = ;\n")).rejects.toThrow();
});
