// Engine plugin hooks for agent assist (agent-assist.js). PARITY: the same file
// in omnirush-cli and omnirush-gui (see PARITY.sha256). Each app's plugin file
// only calls agentAssistHooks().
//
// - Self-check: after a code edit, the turn's model calls carry a note (an
//   in-memory part of the newest prompt, never stored, after the cached
//   history) to run the project's checks and fix what fails; a check's result
//   is read from the shell call (no extra tool), at most 3 failed rounds per
//   turn, "skip the tests" in the prompt turns it off for the turn. A toast
//   shows "Checked: 42 tests passed" / "Check failed: ..." / "Not checked".
// - Project notes: /init gets the repository facts read here; a change that
//   would drop existing lines of AGENTS.md is refused once with the diff, so
//   the agent asks first, and goes through only after a reply that is not a
//   refusal; at a turn's end a toast offers /init when the session found
//   commands AGENTS.md lacks.
// - Diagnostics: the language servers' "package not installed here" errors
//   are left out of file tool results; their metadata is capped.
// - Compaction: the summary prompt gets more sections and the facts of the
//   whole session; facts a summary leaves out stay beside it in the model's
//   context (never stored in the chat).
//
// Its notes (compaction ledgers, a pending AGENTS.md question) live in
// OMNIRUSH_AGENT_ASSIST_DIR (0700, files 0600, pruned after 30 days); without
// that folder they are kept in memory only.

import fs from "node:fs";
import path from "node:path";

import {
  FEATURES_FILE_ENV,
  admitNote,
  capDiagnosticsMetadata,
  compactionContext,
  declinesChange,
  detectChecks,
  devCommand,
  featuresFromEnv,
  filterDiagnosticsOutput,
  isCheckCommand,
  isCodeEdit,
  latestSummary,
  learnedCommands,
  missingFactsNote,
  newCheckState,
  noteCheckRun,
  noteEdit,
  notesGuardMessage,
  notesLinesDropped,
  noteUserPrompt,
  parseCheckResult,
  projectScan,
  restoreShellEnv,
  selfCheckNote,
  sessionLedger,
} from "./agent-assist.js";

const FILE_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit", "patch"]);
const CHECKS_TTL_MS = 15_000;
const FLAGS_TTL_MS = 5_000;
const COMPACTING_MAX_MS = 10 * 60_000;
const LEDGER_MAX_AGE_MS = 15 * 60_000;
const STATE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

function promptText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.filter((part) => part && part.type === "text" && !part.synthetic && typeof part.text === "string").map((part) => part.text).join("\n");
}

function stateDir(env) {
  const dir = typeof env.OMNIRUSH_AGENT_ASSIST_DIR === "string" ? env.OMNIRUSH_AGENT_ASSIST_DIR.trim() : "";
  return dir || null;
}

/** Removes the folder's notes older than 30 days (sessions long gone). */
function pruneState(dir, now) {
  if (!dir) return;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!/^(?:ledger-.*\.json|notes-pending-.*)$/.test(name)) continue;
    try {
      const file = path.join(dir, name);
      if (now - fs.statSync(file).mtimeMs > STATE_MAX_AGE_MS) fs.rmSync(file, { force: true });
    } catch { /* gone */ }
  }
}

export function agentAssistHooks(input = {}, { env = process.env, now = () => Date.now(), log = () => undefined } = {}) {
  // The switches can change while the engine runs (the desktop app rewrites its
  // file): read at most every few seconds; every hook checks them.
  let flagsCache = { at: -Infinity, value: featuresFromEnv(env) };
  const flags = () => {
    if (now() - flagsCache.at > FLAGS_TTL_MS) flagsCache = { at: now(), value: featuresFromEnv(env) };
    return flagsCache.value;
  };
  const live = typeof env[FEATURES_FILE_ENV] === "string" && env[FEATURES_FILE_ENV].trim() !== "";
  if (!live && typeof env.OMNIRUSH_LSP_HEAP !== "string" && !Object.values(flags()).some(Boolean)) return {};
  const root = path.resolve(input.directory || input.worktree || process.cwd());
  const client = input.client;
  const dir = stateDir(env);
  const sessions = new Map();
  const ledgers = new Map();
  const pendingInMemory = new Set();
  let checksCache = { at: -Infinity, list: [] };
  pruneState(dir, now());

  const checks = () => {
    if (now() - checksCache.at > CHECKS_TTL_MS) checksCache = { at: now(), list: detectChecks(root) };
    return checksCache.list;
  };
  const session = (id) => {
    let st = sessions.get(id);
    if (!st) {
      st = { check: newCheckState(), compactingSince: 0, notesBlocked: false, notesAllowed: false, worked: [], offered: new Set() };
      sessions.set(id, st);
    }
    return st;
  };
  const compacting = (st) => st.compactingSince > 0 && now() - st.compactingSince < COMPACTING_MAX_MS;
  const toast = (title, message, variant = "info") => {
    try {
      // The project's own engine instance: one engine serves several projects in the desktop app.
      const sent = client?.tui?.showToast?.({ body: { title, message, variant, duration: 8000 }, query: { directory: root } });
      if (sent && typeof sent.catch === "function") sent.catch(() => undefined);
    } catch { /* the app shows no toast */ }
  };
  const safe = (id) => String(id).replace(/[^\w-]/g, "_");
  const writeState = (name, content) => {
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, name), content, { mode: 0o600 });
    } catch { /* memory only */ }
  };
  // A refused AGENTS.md change waits for the person's answer, also across engine runs (headless -p turns).
  const markPending = (id, on) => {
    if (on) pendingInMemory.add(id);
    else pendingInMemory.delete(id);
    if (on) writeState(`notes-pending-${safe(id)}`, "");
    else if (dir) {
      try { fs.rmSync(path.join(dir, `notes-pending-${safe(id)}`), { force: true }); } catch { /* gone */ }
    }
  };
  const pending = (id) => {
    if (pendingInMemory.has(id)) return true;
    if (!dir) return false;
    try { return fs.existsSync(path.join(dir, `notes-pending-${safe(id)}`)); } catch { return false; }
  };
  const saveLedger = (id, entry) => {
    ledgers.set(id, entry);
    writeState(`ledger-${safe(id)}.json`, JSON.stringify(entry));
  };
  const loadLedger = (id) => {
    if (ledgers.has(id)) return ledgers.get(id);
    if (!dir) return null;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, `ledger-${safe(id)}.json`), "utf8"));
      ledgers.set(id, entry);
      return entry;
    } catch {
      return null;
    }
  };
  const sessionMessages = async (id) => {
    try {
      const response = await client?.session?.messages?.({ path: { id }, query: { directory: root } });
      return Array.isArray(response?.data) ? response.data : [];
    } catch (error) {
      log("warn", "agent assist: messages unavailable", { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  };
  /** A copy of `message` with one more in-memory text part (the stored chat is never changed). */
  const withPart = (message, id, text) => {
    const template = message.parts.find((part) => part?.type === "text") ?? { sessionID: message.info?.sessionID, messageID: message.info?.id };
    return { ...message, parts: [...message.parts, { ...template, id: `${template.id ?? `prt_${message.info?.id ?? "x"}`}_${id}`, type: "text", text, synthetic: true }] };
  };

  const hooks = {};

  hooks["chat.message"] = async (info, output) => {
    if (!info?.sessionID) return;
    const text = promptText(output?.parts);
    if (!text) return; // the engine's own follow-ups (a synthetic "continue")
    const st = session(info.sessionID);
    noteUserPrompt(st.check, text);
    // The person answered after a refused AGENTS.md change: this turn may apply it, unless the answer declines.
    const asked = st.notesBlocked || pending(info.sessionID);
    st.notesAllowed = asked && !declinesChange(text);
    if (asked) markPending(info.sessionID, false);
    st.notesBlocked = false;
  };

  hooks["tool.execute.before"] = async (info, output) => {
    if (!flags().projectNotes || !FILE_TOOLS.has(String(info?.tool || "").toLowerCase())) return;
    const drops = notesLinesDropped(info.tool, output?.args, root);
    if (!drops.length) return;
    const st = session(info.sessionID);
    if (st.notesAllowed) return;
    st.notesBlocked = true;
    markPending(info.sessionID, true);
    throw new Error(notesGuardMessage(drops));
  };

  hooks["command.execute.before"] = async (info, output) => {
    if (!flags().projectNotes || info?.command !== "init" || !Array.isArray(output?.parts)) return;
    const st = session(info.sessionID);
    output.parts.push({ type: "text", text: projectScan(root, { learned: learnedCommands(st.worked, root) }), synthetic: true });
  };

  hooks["tool.execute.after"] = async (info, output) => {
    if (!info?.sessionID || !output) return;
    const tool = String(info.tool || "").toLowerCase();
    const on = flags();
    const st = session(info.sessionID);
    if (FILE_TOOLS.has(tool)) {
      if (on.diagnostics) {
        const filtered = filterDiagnosticsOutput(output.output);
        if (filtered.removed > 0) output.output = filtered.text;
        // apply_patch repeats its output as the title.
        if (typeof output.title === "string" && output.title.includes("<diagnostics")) output.title = filterDiagnosticsOutput(output.title).text;
        if (output.metadata && typeof output.metadata === "object" && output.metadata.diagnostics) {
          output.metadata.diagnostics = capDiagnosticsMetadata(output.metadata.diagnostics);
        }
      }
      if (on.selfCheck && isCodeEdit(tool, info.args)) noteEdit(st.check);
      return;
    }
    if (tool !== "bash" && tool !== "shell") return;
    const command = typeof info.args?.command === "string" ? info.args.command : "";
    const exit = typeof output.metadata?.exit === "number" ? output.metadata.exit : null;
    if (on.projectNotes && exit === 0 && devCommand(command)) {
      st.worked.push(command);
      if (st.worked.length > 50) st.worked.shift();
    }
    if (on.selfCheck && isCheckCommand(command, checks())) {
      const text = typeof output.output === "string" ? output.output : String(output.metadata?.output ?? "");
      const result = parseCheckResult(text, exit, command);
      noteCheckRun(st.check, result);
      const [title, ...rest] = result.summary.split(": ");
      toast(title, rest.join(": "), result.ok ? "success" : "warning");
    }
  };

  hooks["experimental.session.compacting"] = async (info, output) => {
    if (!info?.sessionID || !output) return;
    const st = session(info.sessionID);
    // Also with the summaries' extras off: no self-check note in the compaction request.
    st.compactingSince = now();
    if (!flags().compaction) return;
    const ledger = sessionLedger(await sessionMessages(info.sessionID));
    saveLedger(info.sessionID, { at: now(), ledger });
    if (Array.isArray(output.context)) output.context.push(compactionContext(ledger));
  };

  // Every model call's messages (an in-memory copy; the stored chat is never changed).
  hooks["experimental.chat.messages.transform"] = async (_info, output) => {
    const messages = output?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;
    const id = messages[0]?.info?.sessionID;
    if (!id) return;
    const on = flags();
    const st = sessions.get(id);
    const summary = latestSummary(messages);
    if (st && compacting(st)) {
      // The compaction's own request (no new summary yet), or the first one after it.
      if (!summary || summary.created < st.compactingSince) return;
      st.compactingSince = 0;
    }
    if (on.compaction && summary) {
      const entry = loadLedger(id);
      if (entry && entry.at <= summary.created + 60_000 && summary.created - entry.at <= LEDGER_MAX_AGE_MS) {
        const note = missingFactsNote(entry.ledger, summary.text);
        if (note) messages[summary.index] = withPart(messages[summary.index], "facts", note);
      }
    }
    if (on.selfCheck && st) {
      // On the newest prompt: after the history the provider caches, so a note that comes and goes never re-sends it.
      const note = admitNote(st.check, selfCheckNote(st.check, checks()));
      if (note) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i]?.info?.role !== "user") continue;
          messages[i] = withPart(messages[i], "check", note);
          break;
        }
      }
    }
  };

  // Every shell call and terminal: the person's own NODE_OPTIONS (the language servers' heap cap stays
  // the engine's), and none of this plugin's own variables.
  hooks["shell.env"] = async (_info, output) => restoreShellEnv(env, output);

  hooks.event = async ({ event } = {}) => {
    const id = event?.properties?.sessionID;
    if (!id || !sessions.has(id)) return;
    const st = sessions.get(id);
    if (event.type === "session.compacted" || event.type === "session.error") st.compactingSince = 0;
    if (event.type !== "session.idle") return;
    st.compactingSince = 0;
    st.notesAllowed = false;
    const on = flags();
    if (on.selfCheck && st.check.edits > 0 && !st.check.skip && checks().length > 0) {
      toast("Not checked", `Code changed after the last check. Ask the agent to run \`${checks()[0].command}\`.`, "warning");
    }
    if (on.projectNotes) {
      const fresh = learnedCommands(st.worked, root).filter((command) => !st.offered.has(command));
      if (fresh.length) {
        for (const command of fresh) st.offered.add(command);
        toast("Project notes", `This session found ${fresh.map((c) => `\`${c}\``).join(", ")}. Type /init to add ${fresh.length === 1 ? "it" : "them"} to AGENTS.md.`);
      }
    }
  };

  return hooks;
}
