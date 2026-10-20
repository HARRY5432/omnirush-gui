import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as shared from "./agent-assist/agent-assist.js";
import { agentAssistHooks } from "./agent-assist/agent-assist-hooks.js";
import {
  AGENT_ASSIST_FEATURES,
  LSP_BUILTIN_IDS,
  LSP_ENABLED_IDS,
  LSP_HEAP_MB,
  agentAssistEngineEnv,
  agentAssistFlags,
  agentAssistForced,
  agentAssistLspConfig,
  lspHeapMb,
  normalizeAgentAssistSetting,
  writeAgentAssistFile,
} from "./agent-assist-config.js";
import { buildOmniRushRuntimeConfigObjectFromSnapshot, omnirushOwnPluginPaths } from "./omnirush-runtime-config.js";
import type { ServerConfig } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("agent assist", () => {
  test("CLI/desktop parity: agent-assist/PARITY.sha256 matches its files", () => {
    const dir = join(here, "agent-assist");
    const rows = readFileSync(join(dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const [hash, name] = row.split(/\s+/);
      expect(createHash("sha256").update(readFileSync(join(dir, name!))).digest("hex")).toBe(hash!);
    }
  });

  test("the server's copies of the shared values match agent-assist.js", () => {
    expect([...AGENT_ASSIST_FEATURES]).toEqual(shared.FEATURES);
    expect(LSP_BUILTIN_IDS).toEqual(shared.LSP_BUILTIN_IDS);
    expect(LSP_ENABLED_IDS).toEqual(shared.LSP_ENABLED_IDS);
    expect(LSP_HEAP_MB).toBe(shared.LSP_HEAP_MB);
    expect(agentAssistLspConfig()).toEqual(shared.lspConfig());
    for (const env of [{}, { OMNIRUSH_SELF_CHECK: "0" }, { OMNIRUSH_CODE_DIAGNOSTICS: "off", OMNIRUSH_SMART_COMPACTION: "1" }]) {
      for (const saved of [undefined, { compaction: false }, { selfCheck: false, diagnostics: true }]) {
        expect(agentAssistFlags({ agentAssist: saved }, env)).toEqual(shared.featureFlags({ env, settings: { agentAssist: saved } }));
      }
    }
    const config = { configPath: "/data/server.json" } as unknown as ServerConfig;
    const env = agentAssistEngineEnv(config, { NODE_OPTIONS: "--trace-warnings" });
    expect(lspHeapMb(4 * 1024 ** 3)).toBe(shared.lspHeapMb(4 * 1024 ** 3));
    expect(lspHeapMb(64 * 1024 ** 3)).toBe(shared.lspHeapMb(64 * 1024 ** 3));
    // Diagnostics off at the start: no heap cap in the engine's env.
    expect(agentAssistEngineEnv(config, { NODE_OPTIONS: "--x" }, { diagnostics: false }).NODE_OPTIONS).toBeUndefined();
    const expected: Record<string, string> = shared.lspEngineEnv({ NODE_OPTIONS: "--trace-warnings" });
    expect({ NODE_OPTIONS: env.NODE_OPTIONS, OMNIRUSH_USER_NODE_OPTIONS: env.OMNIRUSH_USER_NODE_OPTIONS, OMNIRUSH_LSP_HEAP: env.OMNIRUSH_LSP_HEAP } as Record<string, string | undefined>).toEqual(expected);
  });

  test("the saved setting keeps booleans only; env switches are reported as forced", () => {
    expect(normalizeAgentAssistSetting({ selfCheck: false, other: false, compaction: "no" })).toEqual({ selfCheck: false });
    expect(normalizeAgentAssistSetting({})).toBeUndefined();
    expect(agentAssistForced({ OMNIRUSH_PROJECT_NOTES: "0" })).toEqual(["projectNotes"]);
  });

  test("engine config: the plugin always (inert while off), the language servers only while diagnostics are on", () => {
    const on = buildOmniRushRuntimeConfigObjectFromSnapshot({}, undefined, {});
    expect((on.plugin as string[]).some((entry) => /omnirush-agent-assist\.(?:js|ts)$/.test(entry))).toBe(true);
    expect(on.lsp).toEqual(agentAssistLspConfig());
    expect(omnirushOwnPluginPaths().some((entry) => /omnirush-agent-assist\.(?:js|ts)$/.test(entry))).toBe(true);
    const off = buildOmniRushRuntimeConfigObjectFromSnapshot({ agentAssist: { diagnostics: false } }, undefined, {});
    expect(off.lsp).toBeUndefined();
    expect(off.agentAssist).toBeUndefined();
    expect(buildOmniRushRuntimeConfigObjectFromSnapshot({}, undefined, { OMNIRUSH_CODE_DIAGNOSTICS: "0" }).lsp).toBeUndefined();
  });

  test("the switch file is what the plugin reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-assist-"));
    const config = { configPath: join(dir, "server.json") } as unknown as ServerConfig;
    const flags = { selfCheck: true, projectNotes: false, diagnostics: true, compaction: false };
    expect(await writeAgentAssistFile(config, flags)).toBe(true);
    expect(await writeAgentAssistFile(config, flags)).toBe(false);
    const env = agentAssistEngineEnv(config, {});
    expect(JSON.parse(await readFile(env.OMNIRUSH_AGENT_ASSIST_FILE!, "utf8"))).toEqual({ features: ["selfCheck", "diagnostics"] });
    expect(shared.featuresFromEnv(env)).toEqual(flags);
    expect(Object.keys(agentAssistHooks({ directory: dir }, { env }))).toContain("experimental.chat.messages.transform");
  });
});
