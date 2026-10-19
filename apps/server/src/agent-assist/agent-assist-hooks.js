// Engine plugin hooks for agent assist (agent-assist.js). PARITY: the same file
// in omnirush-cli and omnirush-gui (see PARITY.sha256). Each app's plugin file
// only calls agentAssistHooks().
//
// - Self-check: after a code edit, every model call of the turn gets a system
//   note to run the project's checks and fix what fails; a check's result is
//   read from the shell call (no extra tool), at most 3 failed rounds per turn,
//   "skip the tests" in the prompt turns it off for the turn. A toast shows
//   "Checked: 42 tests passed" / "Check failed: ..." / "Not checked".
// - Project notes: /init gets the repository facts read here; a change that
//   would drop existing lines of AGENTS.md is refused once with the diff, so
//   the agent asks first; at a turn's end a toast offers /init when the
//   session found commands AGENTS.md lacks.
// - Diagnostics: the language servers' "package not installed here" errors
//   are left out of file tool results; their metadata is capped.
// - Compaction: the summary prompt gets more sections and the facts of the
//   whole session; facts a summary leaves out stay beside it in the model's
//   context (never stored in the chat).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FEATURES_FILE_ENV,
  compactionContext,
  detectChecks,
  devCommand,
  featuresFromEnv,
  filterDiagnosticsOutput,
  capDiagnosticsMetadata,
  isCheckCommand,
  isCodeEdit,
  admitNote,
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

function promptText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.filter((part) => part && part.type === "text" && !part.synthetic && typeof part.text === "string").map((part) => part.text).join("\n");
}

function ledgerDir(env) {
  const dir = typeof env.OMNIRUSH_AGENT_ASSIST_DIR === "string" && env.OMNIRUSH_AGENT_ASSIST_DIR.trim()
    ? env.OMNIRUSH_AGENT_ASSIST_DIR.trim()
    : path.join(os.tmpdir(), `omnirush-agent-assist-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
  return dir;
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
  const heap = typeof env.OMNIRUSH_LSP_HEAP === "string";
  if (!live && !heap && !Object.values(flags()).some(Boolean)) return {};
  const root = path.resolve(input.directory || input.worktree || process.cwd());
  const client = input.client;
  const sessions = new Map();
  const ledgers = new Map();
  let checksCache = { at: -Infinity, list: [] };

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
      const sent = client?.tui?.showToast?.({ body: { title, message, variant, duration: 8000 } });
      if (sent && typeof sent.catch === "function") sent.catch(() => undefined);
    } catch { /* the app shows no toast */ }
  };
  const ledgerFile = (id) => path.join(ledgerDir(env), `ledger-${String(id).replace(/[^\w-]/g, "_")}.json`);
  // A refused AGENTS.md change waits for the person's answer, also across engine runs (headless -p turns).
  const pendingFile = (id) => path.join(ledgerDir(env), `notes-pending-${String(id).replace(/[^\w-]/g, "_")}`);
  const markPending = (id, on) => {
    try {
      if (on) {
        fs.mkdirSync(ledgerDir(env), { recursive: true, mode: 0o700 });
        fs.writeFileSync(pendingFile(id), "", { mode: 0o600 });
      } else fs.rmSync(pendingFile(id), { force: true });
    } catch { /* memory only */ }
  };
  const pending = (id) => {
    try { return fs.existsSync(pendingFile(id)); } catch { return false; }
  };
  const saveLedger = (id, entry) => {
    ledgers.set(id, entry);
    try {
      fs.mkdirSync(ledgerDir(env), { recursive: true, mode: 0o700 });
      fs.writeFileSync(ledgerFile(id), JSON.stringify(entry), { mode: 0o600 });
    } catch { /* memory only */ }
  };
  const loadLedger = (id) => {
    if (ledgers.has(id)) return ledgers.get(id);
    try {
      const entry = JSON.parse(fs.readFileSync(ledgerFile(id), "utf8"));
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

  const hooks = {};

  hooks["chat.message"] = async (info, output) => {
    if (!info?.sessionID) return;
    const text = promptText(output?.parts);
    if (!text) return; // the engine's own follow-ups (a synthetic "continue")
    const st = session(info.sessionID);
    noteUserPrompt(st.check, text);
    // The person answered after a refused AGENTS.md change: this turn may apply it.
    st.notesAllowed = st.notesBlocked || pending(info.sessionID);
    if (st.notesAllowed) markPending(info.sessionID, false);
    st.notesBlocked = false;
  };

  {
    hooks["experimental.chat.system.transform"] = async (info, output) => {
      if (!flags().selfCheck || !info?.sessionID || !Array.isArray(output?.system)) return;
      const st = sessions.get(info.sessionID);
      if (!st || compacting(st)) return;
      const note = admitNote(st.check, selfCheckNote(st.check, checks()));
      if (note) output.system.push(note);
    };
  }

  {
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
  }

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

  {
    hooks["experimental.session.compacting"] = async (info, output) => {
      if (!flags().compaction || !info?.sessionID || !output) return;
      const st = session(info.sessionID);
      st.compactingSince = now();
      const ledger = sessionLedger(await sessionMessages(info.sessionID));
      saveLedger(info.sessionID, { at: now(), ledger });
      if (Array.isArray(output.context)) output.context.push(compactionContext(ledger));
    };
    hooks["experimental.chat.messages.transform"] = async (_info, output) => {
      const messages = output?.messages;
      if (!flags().compaction || !Array.isArray(messages) || messages.length === 0) return;
      const id = messages[0]?.info?.sessionID;
      if (!id) return;
      const st = sessions.get(id);
      const summary = latestSummary(messages);
      if (st && compacting(st)) {
        // The compaction's own request (no new summary yet), or the first one after it.
        if (!summary || summary.created < st.compactingSince) return;
        st.compactingSince = 0;
      }
      if (!summary) return;
      const entry = loadLedger(id);
      if (!entry || entry.at > summary.created + 60_000 || summary.created - entry.at > LEDGER_MAX_AGE_MS) return;
      const note = missingFactsNote(entry.ledger, summary.text);
      if (!note) return;
      const message = messages[summary.index];
      const template = message.parts.find((part) => part?.type === "text") ?? {};
      // A new object: the stored chat is never changed.
      messages[summary.index] = {
        ...message,
        parts: [...message.parts, { ...template, id: `${template.id ?? "prt"}_facts`, type: "text", text: note, synthetic: true }],
      };
    };
  }

  // Whenever the servers' heap cap is in the engine's env: the person's commands never get it.
  if (heap) hooks["shell.env"] = async (_info, output) => restoreShellEnv(env, output);

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
