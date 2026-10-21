import { timingSafeEqual } from "node:crypto";
import { posix } from "node:path";

/**
 * Settings writes need the app itself.
 *
 * The local server's bearer reaches places the app does not control: the engine holds it, an
 * agent command can read the engine's process environment, and the desktop keeps its tokens in a
 * file under the profile. So a bearer alone must not be enough to change what the person decided:
 * approvals and permission mode, project config, plugins, skills, commands, MCP servers, folder
 * access, the sandbox, tokens, environment and provider keys, or the answer to an approval question.
 *
 * Electron main holds a per-launch secret in this process only (never on disk, never in an
 * environment) and adds it as APP_SECRET_HEADER to the app window's requests to this server (and
 * to its own). Those routes then need it. Without a secret configured (a server run on its own,
 * not inside the desktop app) nothing changes.
 */
export const APP_SECRET_KEY = Symbol.for("omnirush.app.request-secret");
export const APP_SECRET_HEADER = "x-omnirush-app-secret";

export const APP_REQUIRED_CODE = "app_required";
export const APP_REQUIRED_MESSAGE = "This change can only be made in the OmniRush.ai app.";

function heldSecret(): string | null {
  const held: unknown = (globalThis as Record<symbol, unknown>)[APP_SECRET_KEY];
  return typeof held === "string" && held.length >= 32 ? held : null;
}

export function appSecretMatches(given: string | null | undefined): boolean {
  const held = heldSecret();
  if (!held || typeof given !== "string") return false;
  const a = Buffer.from(held), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// App server routes (method other than GET/HEAD/OPTIONS) that change settings.
const SETTINGS_WRITES: RegExp[] = [
  /^\/runtime-config(?:\/|$)/,
  /^\/workspace\/[^/]+\/(?:runtime-config|config|opencode-config|permissions|authorized-folders|box|plugins|claude-plugins|cloud-plugins|skills|commands|mcp|local-workflows|desktop-cloud-sync|engine)(?:\/|$)/,
  /^\/workspaces(?:\/|$)/,
  /^\/tokens(?:\/|$)/,
  /^\/env(?:\/|$)/,
  /^\/den-session$/,
  /^\/cloud-provider-sync(?:\/|$)/,
  /^\/runtime\/upgrade$/,
  /^\/approvals(?:\/|$)/,
  /^\/experimental\/(?:engine-v2-preview|connect\/state)$/,
  /^\/experimental\/ui-control\/[^/]+\/reply$/,
  /^\/omnirush\/subagent-model$/,
];

// App server reads that hand out secrets (environment values, provider keys, tokens): any method.
const SECRET_READS: RegExp[] = [
  /^\/env(?:\/|$)/,
  /^\/runtime-config\/providers$/,
  /^\/tokens(?:\/|$)/,
];

// Engine routes behind the proxy (path after the /opencode or /opencode2 segment), any method but
// GET/HEAD/OPTIONS: answers to approval questions, and the engine's own config, keys and MCP list.
const ENGINE_WRITES: RegExp[] = [
  // any answer to a question: permission/permissions, question, or the preview engine's form replies,
  // wherever the segment sits (a session id with an encoded slash must not move it out of place)
  /(?:^|\/)(?:permission|permissions|question|form)(?:\/|$)/,
  /^\/(?:api\/)?(?:global\/)?config(?:\/|$)/,
  /^\/(?:api\/)?auth(?:\/|$)/,
  /^\/(?:api\/)?mcp(?:\/|$)/,
  /^\/(?:api\/)?provider(?:\/|$)/,
  /^\/(?:api\/)?model\/default(?:\/|$)/,
];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The path as routes would see it: percent-escapes, backslashes, repeated slashes, dot segments and `;params` resolved. Null when it cannot be read. */
export function normalizedRequestPath(pathname: string): string | null {
  let path = pathname;
  try {
    for (let i = 0; i < 3; i += 1) {
      const next = decodeURIComponent(path);
      if (next === path) break;
      path = next;
    }
  } catch {
    return null;
  }
  path = path.replace(/\\/g, "/").replace(/;[^/]*/g, "");
  path = posix.normalize(`/${path}`).replace(/\/+$/, "") || "/";
  // A mounted base URL (/w/<id>/...) routes on the rest.
  const mount = /^\/w\/[^/]+(\/.*)?$/.exec(path);
  if (mount) path = mount[1] || "/";
  return path;
}

/** The engine path of a proxied request (after its /opencode or /opencode2 segment), or null for an app server route. */
function enginePath(path: string): string | null {
  const segments = path.split("/");
  const at = segments.findIndex((segment) => segment === "opencode" || segment === "opencode2");
  if (at === -1) return null;
  if (at !== 1 && !(at === 3 && segments[1] === "workspace")) return null;
  return `/${segments.slice(at + 1).join("/")}`;
}

/** Whether a request needs the app's secret: a settings write, a secret read, or an engine decision. */
export function needsApp(method: string, pathname: string): boolean {
  const upper = method.toUpperCase();
  const write = !READ_METHODS.has(upper);
  const path = normalizedRequestPath(pathname);
  if (path === null) return write;
  const engine = enginePath(path);
  if (engine !== null) return write && ENGINE_WRITES.some((rule) => rule.test(engine));
  if (SECRET_READS.some((rule) => rule.test(path))) return upper !== "OPTIONS";
  return write && SETTINGS_WRITES.some((rule) => rule.test(path));
}

/** The refusal for a request that needs the app and does not carry its secret, or null. */
export function appRequestRefusal(method: string, pathname: string, headers: Headers): { code: string; message: string } | null {
  if (!heldSecret()) return null;
  if (!needsApp(method, pathname)) return null;
  if (appSecretMatches(headers.get(APP_SECRET_HEADER))) return null;
  return { code: APP_REQUIRED_CODE, message: APP_REQUIRED_MESSAGE };
}
