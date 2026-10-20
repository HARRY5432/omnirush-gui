import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildOmniRushRuntimeConfigObject,
  buildOmniRushRuntimeConfigObjectFromSnapshot,
  omnirushRuntimeSkillsDir,
  writeOmniRushRuntimeConfigFile,
} from "./omnirush-runtime-config.js";
import { omnirushBestPracticesSkillsDir } from "./best-practices.js";
import { listSkills } from "./skills.js";
import { OMNIRUSH_SWARM_SKILL_NAME } from "./omnirush-swarm.js";
import { engineGlobalConfigDir, mergeSkillPaths, userGlobalSkillPaths } from "./user-skill-paths.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "omnirush-user-skills-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  setEnv("HOME", home);
  setEnv("USERPROFILE", home);
  setEnv("XDG_CONFIG_HOME", join(home, ".config"));
  setEnv("OPENCODE_CONFIG_DIR", undefined);
  setEnv("OMNIRUSH_RUNTIME_DB", join(home, ".config", "omnirush", "runtime.sqlite"));
  const workspace = join(root, "project");
  await mkdir(workspace, { recursive: true });
  const config = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspace, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspace],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
  } as unknown as ServerConfig;
  return { root, home, workspace, config };
}

async function skill(dir: string, name: string) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: test ${name}\n---\nbody\n`);
}

describe("user skill folders", () => {
  test("the global config's skills.paths are read as the engine takes them, never written", async () => {
    const { home } = await setup();
    const dir = engineGlobalConfigDir(process.env);
    expect(dir).toBe(join(home, ".config", "omnirush"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify({ skills: { paths: ["/older"] } }));
    const file = join(dir, "opencode.jsonc");
    const bytes = '{\n  // mine\n  "skills": { "paths": ["~/my-skills", "/abs/team",], "urls": ["https://example.invalid/skills/"] },\n}\n';
    await writeFile(file, bytes);
    expect(await userGlobalSkillPaths(process.env)).toEqual(["~/my-skills", "/abs/team"]);
    expect(await readFile(file, "utf8")).toBe(bytes);
    // A config kept elsewhere and linked in (a dotfile manager) is read, as the engine reads it.
    await rm(file);
    const linked = join(home, "dotfiles", "opencode.json");
    await mkdir(join(home, "dotfiles"), { recursive: true });
    await writeFile(linked, JSON.stringify({ skills: { paths: ["/linked"] } }));
    await symlink(linked, join(dir, "opencode.json"));
    expect(await userGlobalSkillPaths(process.env)).toEqual(["/linked"]);
    expect(mergeSkillPaths(["/app"], ["/app", "/a"], undefined, ["/b"])).toEqual(["/app", "/a", "/b"]);
  });

  test("the app's engine config keeps the user's folders after its own; without them it is unchanged", () => {
    const own = ["/state/skills", "/state/best-practices"];
    const plain = buildOmniRushRuntimeConfigObjectFromSnapshot({}, undefined, process.env, undefined, own[0], own[1], null);
    expect(plain.skills).toEqual({ paths: own });
    expect(buildOmniRushRuntimeConfigObjectFromSnapshot({}, undefined, process.env, undefined, own[0], own[1], null, [])).toEqual(plain);
    const withUser = buildOmniRushRuntimeConfigObjectFromSnapshot({}, undefined, process.env, undefined, own[0], own[1], null, ["~/my-skills", own[0]]);
    expect(withUser.skills).toEqual({ paths: [...own, "~/my-skills"] });
    // Best practices off: the user's folders stay.
    const off = buildOmniRushRuntimeConfigObjectFromSnapshot({ bestPractices: false }, undefined, process.env, undefined, own[0], own[1], null, ["~/my-skills"]);
    expect(off.skills).toEqual({ paths: [own[0], "~/my-skills"] });
    // No app folders (specs, previews) and no user folders: still no skills key.
    expect(buildOmniRushRuntimeConfigObjectFromSnapshot({}).skills).toBeUndefined();
  });

  test("an app update keeps the user's skills: same folders before and after, user files untouched", async () => {
    const { home, workspace, config } = await setup();
    const globalDir = engineGlobalConfigDir(process.env);
    await mkdir(globalDir, { recursive: true });
    const userConfig = join(globalDir, "opencode.json");
    const userBytes = `${JSON.stringify({ skills: { paths: [join(home, "team-skills")] } }, null, 2)}\n`;
    await writeFile(userConfig, userBytes);
    await skill(join(home, "team-skills"), "team-review");
    await skill(join(globalDir, "skills"), "cli-made");
    await skill(join(home, ".config", "opencode", "skills"), "desktop-global");
    await skill(join(workspace, ".opencode", "skills"), "workspace-skill");

    // Start of the old version, then of the new one (the same user files; the app regenerates its own file).
    const before = await writeOmniRushRuntimeConfigFile(config);
    const first = JSON.parse(await readFile(before.path, "utf8")) as { skills: { paths: string[] } };
    await rm(before.path);
    const after = await writeOmniRushRuntimeConfigFile(config);
    const second = JSON.parse(await readFile(after.path, "utf8")) as { skills: { paths: string[] } };
    expect(second).toEqual(first);
    expect(second.skills.paths).toEqual([
      omnirushRuntimeSkillsDir(config),
      omnirushBestPracticesSkillsDir(config),
      join(home, "team-skills"),
    ]);
    expect((await buildOmniRushRuntimeConfigObject(config)).skills).toEqual(second.skills);
    expect(await readFile(userConfig, "utf8")).toBe(userBytes);

    // The Library lists every folder the engine reads, but not the app's own swarm skill.
    const names = (await listSkills(workspace, true)).map((item) => item.name).sort();
    expect(names).toEqual(["cli-made", "desktop-global", "team-review", "workspace-skill"]);
    expect(names).not.toContain(OMNIRUSH_SWARM_SKILL_NAME);
  });
});
