import { expect, test } from "bun:test";
import { z } from "zod";

import { BOX_NOTE } from "../box/plugin-lib.js";
import { OMNIRUSH_BEST_PRACTICES } from "../best-practices.js";
import { AGENT_RULES_HEADING, DEFAULT_AGENT_RULES } from "../buildathon-repro.js";
import { renderOmniRushAutomationInstruction } from "../connect-automation-catalog.js";
import { GIT_IDENTITY_REQUIRED_MESSAGE } from "../managed-git-identity.js";
import { DESTRUCTIVE_MARKER } from "../git-command-policy.js";
import { OMNIRUSH_AGENT_PROMPT } from "../omnirush-agent-prompt.js";
import { buildOmniRushRuntimeConfigObjectFromSnapshot } from "../omnirush-runtime-config.js";
import {
  OMNIRUSH_SWARM_SKILL_NAME,
  OMNIRUSH_TASK_TOOL_NOTE,
  omnirushSubagentNote,
  omnirushSwarmSkillMarkdown,
  omnirushSwarmSubagentNote,
} from "../omnirush-swarm.js";
import { buildOmniRushV2Instructions } from "../opencode-v2-instructions.js";
import { automationRuntimeKnowledge, OmniRushCapabilitiesKnowledge } from "./omnirush-capabilities-knowledge.js";
import { server as ChromeDevtools } from "./omnirush-chrome-devtools.js";
import { OmniRushExtensionsPreview } from "./omnirush-extensions-preview.js";
import {
  OMNIRUSH_CLOUD_CONNECTION_INSTRUCTION,
  OMNIRUSH_CLOUD_SKILL_AUTHORING_INSTRUCTION,
  OMNIRUSH_CONNECT_DISABLED_INSTRUCTION,
  OMNIRUSH_CONNECT_SIGN_IN_INSTRUCTION,
  OMNIRUSH_EXTENSION_DISCOVERY_INSTRUCTION,
  OMNIRUSH_LOCAL_SKILL_AUTHORING_INSTRUCTION,
} from "./omnirush-extensions-preview-steering.js";
import { OmniRushPdfAttachments } from "./omnirush-pdf-attachments.js";
import { OmniRushSpreadsheets } from "./omnirush-spreadsheets.js";
import { OmniRushSwarm } from "./omnirush-swarm.js";

// The text the model reads names no product. Allowed: the workspace folder the
// swarm board lives in (`.omnirush/`), a path rather than wording.
const BRAND = /omni[\s_.-]*rush/i;
const ALLOWED_PATHS = /\.omnirush\//g;

function brandHits(text: string): string[] {
  const clean = text.replace(ALLOWED_PATHS, "./");
  const hits: string[] = [];
  for (const match of clean.matchAll(new RegExp(BRAND.source, "gi"))) {
    hits.push(clean.slice(Math.max(0, match.index - 60), match.index + 60));
  }
  return hits;
}

type Tool = { description?: string; args?: Record<string, z.ZodType> };

function toolTexts(tools: Record<string, Tool> | undefined): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const [name, tool] of Object.entries(tools ?? {})) {
    texts[`tool name ${name}`] = name;
    texts[`tool ${name} description`] = tool.description ?? "";
    texts[`tool ${name} schema`] = JSON.stringify(z.toJSONSchema(z.object(tool.args ?? {})));
  }
  return texts;
}

async function composed(status: string): Promise<string> {
  const engineMcp = { async status() { return { data: { "omnirush-cloud": { status } } }; } };
  const extensions = await OmniRushExtensionsPreview({ client: { mcp: engineMcp }, directory: "/tmp/spec" });
  const knowledge = await OmniRushCapabilitiesKnowledge();
  const spreadsheets = await OmniRushSpreadsheets({ directory: "/tmp/spec" });
  const output = { system: [`${OMNIRUSH_AGENT_PROMPT}\n\n${OMNIRUSH_BEST_PRACTICES.systemPrompt}`] };
  await knowledge["experimental.chat.system.transform"]({}, output);
  await extensions["experimental.chat.system.transform"]({}, output);
  await spreadsheets["experimental.chat.system.transform"]({}, output);
  return output.system.join("\n\n");
}

test("model-facing prompts, notes and tool definitions name no product", async () => {
  const texts: Record<string, string> = {
    "composed prompt (Connect ready)": await composed("connected"),
    "composed prompt (Connect signed out)": await composed("needs_auth"),
    "composed prompt (Connect disabled)": await composed("disabled"),
    "composed prompt (no Connect)": await composed("failed"),
    "steering: discovery": OMNIRUSH_EXTENSION_DISCOVERY_INSTRUCTION,
    "steering: ready": OMNIRUSH_CLOUD_CONNECTION_INSTRUCTION,
    "steering: sign in": OMNIRUSH_CONNECT_SIGN_IN_INSTRUCTION,
    "steering: disabled": OMNIRUSH_CONNECT_DISABLED_INSTRUCTION,
    "skill authoring: cloud": OMNIRUSH_CLOUD_SKILL_AUTHORING_INSTRUCTION,
    "skill authoring: local": OMNIRUSH_LOCAL_SKILL_AUTHORING_INSTRUCTION,
    "automations: cloud": automationRuntimeKnowledge("daytona"),
    "automations: none": renderOmniRushAutomationInstruction({ automations: [] } as never),
    "engine v2 (ready)": JSON.stringify(buildOmniRushV2Instructions(true)),
    "engine v2 (not ready)": JSON.stringify(buildOmniRushV2Instructions(false)),
    "best practices skills": JSON.stringify(OMNIRUSH_BEST_PRACTICES.skills.map((skill) => [skill.name, skill.content])),
    "swarm skill": omnirushSwarmSkillMarkdown(),
    "swarm skill name": OMNIRUSH_SWARM_SKILL_NAME,
    "sub-agent notes": [1, 2, 3].map((depth) => `${omnirushSubagentNote(depth)}\n${omnirushSwarmSubagentNote(depth)}`).join("\n"),
    "task tool note": OMNIRUSH_TASK_TOOL_NOTE,
    "box note": BOX_NOTE("/work/app", 0, "/w/app"),
    "buildathon rules": `${AGENT_RULES_HEADING}\n\n${DEFAULT_AGENT_RULES}`,
    "git identity refusal": GIT_IDENTITY_REQUIRED_MESSAGE,
    "destructive marker": DESTRUCTIVE_MARKER,
  };
  const plugins = [
    await OmniRushExtensionsPreview({ directory: "/tmp/spec" }),
    await OmniRushCapabilitiesKnowledge(),
    await OmniRushSpreadsheets({ directory: "/tmp/spec" }),
    await OmniRushPdfAttachments({ directory: "/tmp/spec" }),
    await OmniRushSwarm({ directory: "/tmp/spec" }),
    await ChromeDevtools({}),
  ] as Array<{ tool?: Record<string, Tool> }>;
  for (const plugin of plugins) Object.assign(texts, toolTexts(plugin.tool));

  const found = Object.entries(texts).flatMap(([where, text]) => brandHits(text).map((hit) => `${where}: …${hit}…`));
  expect(found).toEqual([]);
  // The checks above saw the real texts, not empty stand-ins.
  expect(texts["composed prompt (Connect ready)"]).toContain("## App context");
  expect(Object.keys(texts).filter((key) => key.startsWith("tool name ")).length).toBeGreaterThan(10);
});

test("the engine config the app writes lists only neutral built-in skills and agent prompt", () => {
  const config = buildOmniRushRuntimeConfigObjectFromSnapshot({}, undefined, {}, undefined, "/state/skills", "/state/best-practices");
  const agent = (config.agent as Record<string, { prompt?: string; permission?: { skill?: Record<string, string> } }>);
  expect(brandHits(agent.omnirush?.prompt ?? "")).toEqual([]);
  expect(Object.keys(agent.general?.permission?.skill ?? {})).toEqual([OMNIRUSH_SWARM_SKILL_NAME]);
  expect(OMNIRUSH_BEST_PRACTICES.skills.every((skill) => !BRAND.test(skill.name))).toBe(true);
});
