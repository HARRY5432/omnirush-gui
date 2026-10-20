import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { boxKey, recordFile } from "./box/common.js";
import { FormatTrustStore, formatRequest, formatterEnvironment, formatterFor, projectFormatters, runFormatter } from "./routes/editor-format.js";

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

describe("format on save asks before running project code", () => {
  async function prettierProject() {
    const prettier = repoPrettier();
    if (!prettier) return null;
    const root = await project(true);
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(prettier, join(root, "node_modules", "prettier"), "dir");
    return formatterFor(root, join(root, "src/a.ts")) ? root : null;
  }

  test("ask first, then once / always / never, and ask again when the configuration changes", async () => {
    const root = await prettierProject();
    if (!root) return;
    const store = new FormatTrustStore(join(root, "..", `trust-${Date.now()}.json`));
    roots.push(join(root, "..", "trust-placeholder"));
    const text = "export   const   messy={a:1}\n";
    const ask = await formatRequest({ root, path: "src/a.ts", text, trust: null, hash: null, store, sandboxOn: false });
    expect(ask).toMatchObject({ formatter: "Prettier", trust: "ask" });
    if (!("trust" in ask) || ask.trust !== "ask") throw new Error("expected a prompt");
    expect(ask.command).toBe("node node_modules/prettier/bin/prettier.cjs --stdin-filepath=<file>");
    // Once: runs, remembers nothing.
    expect(await formatRequest({ root, path: "src/a.ts", text, trust: "once", hash: ask.hash, store, sandboxOn: false })).toMatchObject({ text: "export const messy = { a: 1 };\n" });
    expect((await formatRequest({ root, path: "src/a.ts", text, trust: null, hash: null, store, sandboxOn: false })).formatter).toBe("Prettier");
    expect(await formatRequest({ root, path: "src/a.ts", text, trust: null, hash: null, store, sandboxOn: false })).toMatchObject({ trust: "ask" });
    // Always: remembered for this project and configuration.
    await formatRequest({ root, path: "src/a.ts", text, trust: "always", hash: ask.hash, store, sandboxOn: false });
    expect(await formatRequest({ root, path: "src/a.ts", text, trust: null, hash: null, store, sandboxOn: false })).toMatchObject({ text: "export const messy = { a: 1 };\n" });
    // A changed configuration asks again.
    await writeFile(join(root, ".prettierrc"), JSON.stringify({ semi: false }));
    const again = await formatRequest({ root, path: "src/a.ts", text, trust: null, hash: null, store, sandboxOn: false });
    expect(again).toMatchObject({ trust: "ask" });
    if (!("trust" in again) || again.trust !== "ask") throw new Error("expected a prompt");
    expect(again.hash).not.toBe(ask.hash);
    // An answer for an older configuration does not run.
    expect(await formatRequest({ root, path: "src/a.ts", text, trust: "once", hash: ask.hash, store, sandboxOn: false })).toMatchObject({ trust: "ask" });
    // Never: remembered, nothing runs.
    expect(await formatRequest({ root, path: "src/a.ts", text, trust: "never", hash: again.hash, store, sandboxOn: false })).toMatchObject({ trust: "denied" });
    expect(await formatRequest({ root, path: "src/a.ts", text, trust: null, hash: null, store, sandboxOn: false })).toMatchObject({ trust: "denied" });
  });

  test("the formatter's environment has no app tokens, engine password or other keys", () => {
    const env = formatterEnvironment({ PATH: "/usr/bin", HOME: "/home/u", LANG: "C.UTF-8", OMNIRUSH_TOKEN: "x", OPENCODE_SERVER_PASSWORD: "y", GITHUB_TOKEN: "z", AWS_SECRET_ACCESS_KEY: "w", LC_ALL: "C" }, "linux");
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", LANG: "C.UTF-8", LC_ALL: "C" });
  });

  test("a project that uses the sandbox never formats on this computer when its box is not running", async () => {
    const root = await prettierProject();
    if (!root) return;
    const home = await mkdtemp(join(tmpdir(), "omnirush-boxhome-"));
    roots.push(home);
    const key = boxKey(root);
    await mkdir(join(home, "boxes"), { recursive: true });
    const record = { v: 1, key, root, croot: root, container: "c", backend: "docker", runtime: "docker", runtime_args: [], host: "127.0.0.1", port: 0, token: "", state: "starting", error: "", uid: 0, gid: 0, home: "/root", shell: "/bin/sh", path_prefix: "", env_file: "", updated: 0, pid: 0 };
    await writeFile(recordFile(home, key), JSON.stringify(record));
    const store = new FormatTrustStore(join(home, "trust.json"));
    const env = { ...process.env, OMNIRUSH_BOX_HOME: home };
    const ask = await formatRequest({ root, path: "src/a.ts", text: "const a=1\n", trust: null, hash: null, store, env, sandboxOn: true });
    expect(ask).toMatchObject({ trust: "ask", sandbox: true });
    if (!("trust" in ask) || ask.trust !== "ask") throw new Error("expected a prompt");
    await expect(formatRequest({ root, path: "src/a.ts", text: "const a=1\n", trust: "once", hash: ask.hash, store, env, sandboxOn: true })).rejects.toThrow(/sandbox is not running/);
  });
});

describe("format on save: arguments, configuration and the sandbox switch", () => {
  async function trustedPrettier() {
    const prettier = repoPrettier();
    if (!prettier) return null;
    const root = await project(true);
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(prettier, join(root, "node_modules", "prettier"), "dir");
    if (!formatterFor(root, join(root, "src/a.ts"))) return null;
    const store = new FormatTrustStore(join(root, "..", `trust-${Math.random().toString(36).slice(2)}.json`));
    return { root, store };
  }

  test("a file named like a flag stays a file name (no plugin is loaded)", async () => {
    const setup = await trustedPrettier();
    if (!setup) return;
    const { root, store } = setup;
    await writeFile(join(root, "..cjs"), "require('fs').writeFileSync(__dirname + '/PWNED', 'x'); module.exports = {};\n");
    await writeFile(join(root, "--plugin=..cjs"), "const a=1\n");
    const ask = await formatRequest({ root, path: "--plugin=..cjs", text: "const a=1\n", trust: null, hash: null, store, sandboxOn: false });
    if (!("trust" in ask) || ask.trust !== "ask") return; // not a Prettier file type here
    const done = await formatRequest({ root, path: "--plugin=..cjs", text: "const a=1\n", trust: "once", hash: ask.hash, store, sandboxOn: false });
    expect(existsSync(join(root, "PWNED"))).toBe(false);
    expect("text" in done ? done.text : null).toBe("const a = 1;\n");
  });

  test("a Prettier config added in a subfolder asks again", async () => {
    const setup = await trustedPrettier();
    if (!setup) return;
    const { root, store } = setup;
    const text = "const a=1\n";
    const ask = await formatRequest({ root, path: "src/a.ts", text, trust: null, hash: null, store, sandboxOn: false });
    if (!("trust" in ask) || ask.trust !== "ask") throw new Error("expected a prompt");
    await formatRequest({ root, path: "src/a.ts", text, trust: "always", hash: ask.hash, store, sandboxOn: false });
    await writeFile(join(root, "src", ".prettierrc"), JSON.stringify({ plugins: ["./x.cjs"] }));
    expect(await formatRequest({ root, path: "src/a.ts", text, trust: null, hash: null, store, sandboxOn: false })).toMatchObject({ trust: "ask" });
  });

  test("with the sandbox on and no box at all, nothing runs; switching the sandbox asks again", async () => {
    const setup = await trustedPrettier();
    if (!setup) return;
    const { root, store } = setup;
    const home = await mkdtemp(join(tmpdir(), "omnirush-nobox-"));
    roots.push(home);
    const env = { ...process.env, OMNIRUSH_BOX_HOME: home };
    const text = "const a=1\n";
    const host = await formatRequest({ root, path: "src/a.ts", text, trust: null, hash: null, store, sandboxOn: false, env });
    if (!("trust" in host) || host.trust !== "ask") throw new Error("expected a prompt");
    await formatRequest({ root, path: "src/a.ts", text, trust: "always", hash: host.hash, store, sandboxOn: false, env });
    // Trusted to run here; with the sandbox switched on it is asked again, and without a box it never runs here.
    const boxed = await formatRequest({ root, path: "src/a.ts", text, trust: null, hash: null, store, sandboxOn: true, env });
    expect(boxed).toMatchObject({ trust: "ask", sandbox: true });
    if (!("trust" in boxed) || boxed.trust !== "ask") throw new Error("expected a prompt");
    await expect(formatRequest({ root, path: "src/a.ts", text, trust: "once", hash: boxed.hash, store, sandboxOn: true, env })).rejects.toThrow(/sandbox is not running/);
  });
});
