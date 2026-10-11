// Ported from the CLI (omnirush-cli assets/opencode-box-plugin.js,
// feat/local-box); keep the two in step. Desktop: a project's box is used
// only when the desktop lists it (box/plugin-lib.ts desktopProjects()).
//
// Engine plugin for a project whose OmniRush box is on (box/). The engine
// runs here, on this machine; its shell tool runs in the box (the engine's
// shell is boxsh, which reads OMNIRUSH_BOX_KEY). This plugin:
//
// - gives each shell call the box key (one engine serves several projects)
//   and the call and session ids the package-manager wrappers write into
//   their lines;
// - keeps the engine's file tools to the project folder and the engine's own
//   folders: everything else is the box's (its /tmp, its HOME), which the
//   file tools would read from this machine instead. The agent is told to
//   use the shell for those. This machine's files outside the project
//   (keys, tokens, other projects) stay out of the session either way;
// - says in the system prompt that commands run on Linux in a container,
//   with the project folder at the same path.
//
// A project whose box is off (not listed, no record, or state "off") is left
// alone. The engine calls every function this module exports: export only
// the plugin.

import path from "node:path";

import { BOX_NOTE, desktopProjects, engineDirs, FILE_TOOLS, keyOf, record, toolPaths, within } from "../box/plugin-lib.js";

export const OmniRushBox = async ({ directory }: { directory?: string }) => {
  const root = path.resolve(directory || process.cwd());
  const key = keyOf(root);
  const current = () => {
    const listed = desktopProjects();
    if (!listed.keys.has(key)) return null;
    const rec = record(key);
    return rec && rec.state !== "off" ? { ...rec, pkglogDir: listed.pkglogDir } : null;
  };
  const active = () => Boolean(current());
  const allowed = [root, ...engineDirs()];
  return {
    "shell.env": async (input: { callID?: string; sessionID?: string }, output: { env: Record<string, string> }) => {
      const rec = current();
      if (!rec) return;
      output.env.OMNIRUSH_BOX_KEY = key;
      // Desktop: box chats note installs in their own raw folder (boxsh forwards it into the box).
      if (rec.pkglogDir) output.env.OMNIRUSH_PKGLOG_DIR = rec.pkglogDir;
      if (input.callID) output.env.OMNIRUSH_CALL = String(input.callID);
      if (input.sessionID) output.env.OMNIRUSH_SESSION = String(input.sessionID);
    },
    "tool.execute.before": async (input: { tool: string }, output: { args?: Record<string, unknown> }) => {
      if (!FILE_TOOLS.has(input.tool) || !active()) return;
      for (const raw of toolPaths(input.tool, output.args ?? {})) {
        const full = path.resolve(root, raw);
        if (allowed.some((dir) => within(full, dir))) continue;
        throw new Error(`${raw} is outside the project folder. This session runs in a sandbox: files outside ${root} live inside the Linux container, not where this tool can see them. Use the shell tool (cat, ls, sed, tee, ...) to read or change them.`);
      }
    },
    "experimental.chat.system.transform": async (_input: unknown, output: { system?: unknown }) => {
      const rec = current();
      if (!rec || !Array.isArray(output.system)) return;
      // In place: the engine keeps its own reference to this array.
      for (let i = 0; i < output.system.length; i += 1) {
        const line = output.system[i];
        if (typeof line === "string") output.system[i] = line.replace(/^(\s*Platform:\s*)(darwin|win32|linux)\s*$/m, "$1linux");
      }
      output.system.push(BOX_NOTE(root, Number(rec.uid) || 0, typeof rec.croot === "string" ? rec.croot : root));
    },
  };
};
