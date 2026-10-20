/**
 * Agent assist in the desktop app: which features are on and what they add to
 * the engine. The features live in the engine plugin
 * (opencode-plugins/omnirush-agent-assist.ts and the shared agent-assist/
 * modules, the same files as the CLI's):
 *
 *   selfCheck     after code edits the agent runs the project's checks and fixes failures
 *   projectNotes  /init writes AGENTS.md from the repository's facts; never drops the
 *                 person's lines without a diff and a yes
 *   diagnostics   language servers (TS/JS, Python, Go, Rust) report errors after edits
 *   compaction    summaries keep preferences, decisions, to-dos, commands, file state
 *
 * All on by default; Settings > General > Agent saves `agentAssist` in the
 * engine-global runtime config. OMNIRUSH_SELF_CHECK, OMNIRUSH_PROJECT_NOTES,
 * OMNIRUSH_CODE_DIAGNOSTICS and OMNIRUSH_SMART_COMPACTION (0/1) in the server's
 * environment win. The plugin reads the features from a small file the server
 * rewrites on every change, so a switch applies at the next model call.
 *
 * The values below mirror agent-assist/agent-assist.js (that file is not part
 * of the server's build output); agent-assist-config.test.ts keeps them equal.
 */
import { mkdir, readFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic-write.js";
import { runtimeStorageDir } from "./runtime-db.js";
import type { RuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

export const AGENT_ASSIST_FEATURES = ["selfCheck", "projectNotes", "diagnostics", "compaction"] as const;
export type AgentAssistFeature = (typeof AGENT_ASSIST_FEATURES)[number];
export type AgentAssistFlags = Record<AgentAssistFeature, boolean>;
export type AgentAssistSetting = Partial<Record<AgentAssistFeature, boolean>>;

const ENV_SWITCH: Record<AgentAssistFeature, string> = {
  selfCheck: "OMNIRUSH_SELF_CHECK",
  projectNotes: "OMNIRUSH_PROJECT_NOTES",
  diagnostics: "OMNIRUSH_CODE_DIAGNOSTICS",
  compaction: "OMNIRUSH_SMART_COMPACTION",
};

/** The engine's built-in language servers; all but LSP_ENABLED_IDS are turned off. */
export const LSP_BUILTIN_IDS = [
  "deno", "typescript", "vue", "eslint", "oxlint", "biome", "gopls", "ruby-lsp", "ty", "pyright",
  "elixir-ls", "zls", "csharp", "razor", "fsharp", "sourcekit-lsp", "rust", "clangd", "svelte", "astro",
  "jdtls", "kotlin-ls", "yaml-ls", "lua-ls", "php intelephense", "prisma", "dart", "ocaml-lsp", "bash",
  "terraform", "texlab", "dockerfile", "gleam", "clojure-lsp", "nixd", "tinymist", "haskell-language-server", "julials",
];
export const LSP_ENABLED_IDS = ["typescript", "deno", "pyright", "gopls", "rust"];
export const LSP_HEAP_MB = 3072;
const LSP_HEAP_MIN_MB = 768;

/** The servers' heap cap: LSP_HEAP_MB, at most a quarter of this machine's memory. */
export function lspHeapMb(totalBytes = totalmem()): number {
  const quarter = Math.floor(totalBytes / 4 / 1024 / 1024);
  return Math.max(LSP_HEAP_MIN_MB, Math.min(LSP_HEAP_MB, quarter || LSP_HEAP_MB));
}

function switchValue(value: string | undefined): boolean | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (["0", "off", "false", "no"].includes(text)) return false;
  if (["1", "on", "true", "yes"].includes(text)) return true;
  return null;
}

/** The saved choice (absent features are on). */
export function normalizeAgentAssistSetting(value: unknown): AgentAssistSetting | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: AgentAssistSetting = {};
  for (const key of AGENT_ASSIST_FEATURES) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry === "boolean") out[key] = entry;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The features on: a server env switch wins, then the saved setting, else on. */
export function agentAssistFlags(runtime: Pick<RuntimeOpencodeConfig, "agentAssist">, env: NodeJS.ProcessEnv = process.env): AgentAssistFlags {
  const saved = runtime.agentAssist ?? {};
  return Object.fromEntries(AGENT_ASSIST_FEATURES.map((key) => [key, switchValue(env[ENV_SWITCH[key]]) ?? saved[key] !== false])) as AgentAssistFlags;
}

/** Which features a server env switch decides (Settings shows them as fixed). */
export function agentAssistForced(env: NodeJS.ProcessEnv = process.env): AgentAssistFeature[] {
  return AGENT_ASSIST_FEATURES.filter((key) => switchValue(env[ENV_SWITCH[key]]) !== null);
}

/** The engine config's `lsp` value while diagnostics are on. */
export function agentAssistLspConfig(): Record<string, { disabled: true }> {
  return Object.fromEntries(LSP_BUILTIN_IDS.filter((id) => !LSP_ENABLED_IDS.includes(id)).map((id) => [id, { disabled: true as const }]));
}

export function agentAssistFilePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "agent-assist.json");
}

/**
 * The engine's env: where the plugin reads its switches and keeps its notes,
 * and, while code diagnostics are on when the engine starts, the language
 * servers' heap cap (NODE_OPTIONS; the plugin puts the person's own
 * NODE_OPTIONS back for every shell call and terminal). Diagnostics turned on
 * later run without the cap until the next start.
 */
export function agentAssistEngineEnv(config: ServerConfig, env: NodeJS.ProcessEnv = process.env, { diagnostics = true, totalBytes }: { diagnostics?: boolean; totalBytes?: number } = {}): Record<string, string> {
  const base = {
    OMNIRUSH_AGENT_ASSIST_FILE: agentAssistFilePath(config),
    OMNIRUSH_AGENT_ASSIST_DIR: join(runtimeStorageDir(config), "agent-assist"),
  };
  if (!diagnostics) return base;
  const heap = lspHeapMb(totalBytes);
  const own = typeof env.NODE_OPTIONS === "string" ? env.NODE_OPTIONS : "";
  const capped = /--max-old-space-size[= ]/.test(own) ? own : `${own} --max-old-space-size=${heap}`.trim();
  return { ...base, NODE_OPTIONS: capped, OMNIRUSH_USER_NODE_OPTIONS: own, OMNIRUSH_LSP_HEAP: String(heap) };
}

/** Rewrites the plugin's switch file when the features changed. */
export async function writeAgentAssistFile(config: ServerConfig, flags: AgentAssistFlags): Promise<boolean> {
  const path = agentAssistFilePath(config);
  const content = `${JSON.stringify({ features: AGENT_ASSIST_FEATURES.filter((key) => flags[key]) })}\n`;
  if ((await readFile(path, "utf8").catch(() => undefined)) === content) return false;
  await mkdir(runtimeStorageDir(config), { recursive: true });
  await writeFileAtomic(path, content);
  return true;
}
