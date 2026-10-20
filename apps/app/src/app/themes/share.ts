/**
 * Custom theme files and share codes.
 *
 * Share code: `omnirush-theme:1:<base64url(deflate-raw(json))>` (plain
 * base64url JSON when the runtime has no CompressionStream). The theme JSON
 * goes through validateThemeData before anything uses it: only known keys,
 * only #rrggbb colours, a short printable name, clamped numbers, and an 8 KB
 * cap before and after decompression.
 */
import {
  BASE_COLOUR_KEYS,
  CODE_KEYS,
  DEFAULT_FONT_SIZE_PX,
  DEFAULT_RADIUS_PX,
  FONT_SIZE_RANGE,
  RADIUS_RANGE,
  TERMINAL_KEYS,
  type CustomTheme,
  type ThemeVariant,
  type ThemeVariantMode,
} from "./types";

export const SHARE_CODE_PREFIX = "omnirush-theme:";
export const SHARE_CODE_VERSION = 1;
export const THEME_FILE_SUFFIX = ".omnirush-theme.json";
/** Upper bound for theme JSON, compressed payloads and decompressed output. */
export const MAX_THEME_BYTES = 8 * 1024;
export const MAX_NAME_LENGTH = 40;

export type ThemeImportResult = { ok: true; theme: CustomTheme } | { ok: false; error: string };

const TOP_KEYS = ["v", "name", "modes", "light", "dark", "radiusPx", "fontSizePx"] as const;
const VARIANT_KEYS = [...BASE_COLOUR_KEYS, "code", "terminal", "highlight"] as const;
const COLOUR = /^#[0-9a-fA-F]{6}$/;
// No control, format (bidi overrides, zero-width), surrogate, private-use or unassigned characters.
const PRINTABLE = /^[^\p{C}]+$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const fail = (error: string): ThemeImportResult => ({ ok: false, error });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function unknownKey(obj: Record<string, unknown>, allowed: readonly string[], where: string): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) return `unknown key "${key.slice(0, 40)}"${where ? ` in ${where}` : ""}`;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readColour(value: unknown, path: string): { colour: string } | { error: string } {
  if (typeof value !== "string" || !COLOUR.test(value)) return { error: `"${path}" must be a colour like #1a2b3c` };
  return { colour: value.toLowerCase() };
}

function validateGroup(
  value: unknown,
  keys: readonly string[],
  path: string,
): { group: Record<string, string> } | { error: string } {
  if (!isPlainObject(value)) return { error: `"${path}" must be an object` };
  const unknown = unknownKey(value, keys, path);
  if (unknown) return { error: unknown };
  const group: Record<string, string> = {};
  for (const key of keys) {
    if (!(key in value)) return { error: `missing colour "${path}.${key}"` };
    const read = readColour(value[key], `${path}.${key}`);
    if ("error" in read) return read;
    group[key] = read.colour;
  }
  return { group };
}

function validateVariant(value: unknown, mode: ThemeVariantMode): { variant: ThemeVariant } | { error: string } {
  if (!isPlainObject(value)) return { error: `"${mode}" must be an object` };
  const unknown = unknownKey(value, VARIANT_KEYS, mode);
  if (unknown) return { error: unknown };
  const out: Record<string, unknown> = {};
  for (const key of BASE_COLOUR_KEYS) {
    if (!(key in value)) return { error: `missing colour "${mode}.${key}"` };
    const read = readColour(value[key], `${mode}.${key}`);
    if ("error" in read) return read;
    out[key] = read.colour;
  }
  const code = validateGroup(value.code, CODE_KEYS, `${mode}.code`);
  if ("error" in code) return code;
  out.code = code.group;
  const terminal = validateGroup(value.terminal, TERMINAL_KEYS, `${mode}.terminal`);
  if ("error" in terminal) return terminal;
  out.terminal = terminal.group;
  if ("highlight" in value) {
    const read = readColour(value.highlight, `${mode}.highlight`);
    if ("error" in read) return read;
    out.highlight = read.colour;
  }
  return { variant: out as ThemeVariant };
}

function readNumber(value: unknown, name: string, range: { min: number; max: number }, fallback: number) {
  if (value === undefined) return { value: fallback };
  if (typeof value !== "number" || !Number.isFinite(value)) return { error: `"${name}" must be a number` };
  return { value: Math.round(clamp(value, range.min, range.max) * 10) / 10 };
}

/**
 * The only way theme data from outside (file, share code, storage) becomes a
 * CustomTheme. Pure: no I/O, no DOM.
 */
export function validateThemeData(input: unknown): ThemeImportResult {
  if (!isPlainObject(input)) return fail("a theme must be a JSON object");
  const unknown = unknownKey(input, TOP_KEYS, "");
  if (unknown) return fail(unknown);
  if (input.v !== 1) return fail("unsupported theme version (expected 1)");

  if (typeof input.name !== "string") return fail('"name" must be text');
  const name = input.name.trim();
  if (name.length === 0) return fail('"name" is empty');
  if ([...name].length > MAX_NAME_LENGTH) return fail(`"name" is longer than ${MAX_NAME_LENGTH} characters`);
  if (!PRINTABLE.test(name)) return fail('"name" contains characters that cannot be shown');

  if (!Array.isArray(input.modes) || input.modes.length === 0 || input.modes.length > 2) {
    return fail('"modes" must list "light", "dark" or both');
  }
  const modes: ThemeVariantMode[] = [];
  for (const mode of input.modes) {
    if (mode !== "light" && mode !== "dark") return fail('"modes" may only contain "light" and "dark"');
    if (modes.includes(mode)) return fail(`"modes" lists "${mode}" twice`);
    modes.push(mode);
  }

  const theme: CustomTheme = { v: 1, name, modes: [], radiusPx: DEFAULT_RADIUS_PX, fontSizePx: DEFAULT_FONT_SIZE_PX };
  for (const mode of ["light", "dark"] as const) {
    const listed = modes.includes(mode);
    const present = mode in input;
    if (listed && !present) return fail(`"modes" lists "${mode}" but there is no ${mode} version`);
    if (!listed && present) return fail(`there is a ${mode} version but "modes" does not list it`);
    if (!listed) continue;
    const result = validateVariant(input[mode], mode);
    if ("error" in result) return fail(result.error);
    theme[mode] = result.variant;
    theme.modes.push(mode);
  }

  const radius = readNumber(input.radiusPx, "radiusPx", RADIUS_RANGE, DEFAULT_RADIUS_PX);
  if ("error" in radius) return fail(radius.error ?? "bad radiusPx");
  const fontSize = readNumber(input.fontSizePx, "fontSizePx", FONT_SIZE_RANGE, DEFAULT_FONT_SIZE_PX);
  if ("error" in fontSize) return fail(fontSize.error ?? "bad fontSizePx");
  theme.radiusPx = radius.value;
  theme.fontSizePx = fontSize.value;
  return { ok: true, theme };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Parses theme JSON text (a file, or a decoded share code) with the size cap. */
export function parseThemeJson(text: string): ThemeImportResult {
  if (byteLength(text) > MAX_THEME_BYTES) return fail("the theme is larger than 8 KB");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail("this is not valid theme JSON");
  }
  return validateThemeData(data);
}

/** Stable JSON for a theme (fixed key order), used for files and share codes. */
export function serializeTheme(theme: CustomTheme, pretty = false): string {
  const variant = (v: ThemeVariant) => {
    const out: Record<string, unknown> = {};
    for (const key of BASE_COLOUR_KEYS) out[key] = v[key];
    out.code = Object.fromEntries(CODE_KEYS.map((key) => [key, v.code[key]]));
    out.terminal = Object.fromEntries(TERMINAL_KEYS.map((key) => [key, v.terminal[key]]));
    if (v.highlight) out.highlight = v.highlight;
    return out;
  };
  const doc: Record<string, unknown> = { v: 1, name: theme.name, modes: theme.modes };
  for (const mode of theme.modes) {
    const v = theme[mode];
    if (v) doc[mode] = variant(v);
  }
  doc.radiusPx = theme.radiusPx;
  doc.fontSizePx = theme.fontSizePx;
  return pretty ? `${JSON.stringify(doc, null, 2)}\n` : JSON.stringify(doc);
}

export function themeFileName(theme: Pick<CustomTheme, "name">): string {
  const slug = theme.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "theme"}${THEME_FILE_SUFFIX}`;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(text: string): Uint8Array | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export type Codec = {
  compress: ((bytes: Uint8Array) => Promise<Uint8Array>) | null;
  /** Inflates, stopping (and returning null) once the output would pass `limit` bytes. */
  decompress: ((bytes: Uint8Array, limit: number) => Promise<Uint8Array | null>) | null;
};

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** deflate-raw via the platform's CompressionStream when it has one. */
export function platformCodec(): Codec {
  const hasCompression = typeof CompressionStream === "function" && typeof DecompressionStream === "function";
  if (!hasCompression) return { compress: null, decompress: null };
  return {
    compress: async (bytes) => {
      const out = await readCapped(
        streamOf(bytes).pipeThrough(new CompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>),
        Number.MAX_SAFE_INTEGER,
      );
      return out ?? new Uint8Array();
    },
    decompress: async (bytes, limit) => {
      try {
        return await readCapped(
          streamOf(bytes).pipeThrough(new DecompressionStream("deflate-raw") as unknown as TransformStream<Uint8Array, Uint8Array>),
          limit,
        );
      } catch {
        return new Uint8Array(0);
      }
    },
  };
}

export async function encodeShareCode(theme: CustomTheme, codec: Codec = platformCodec()): Promise<string> {
  const json = new TextEncoder().encode(serializeTheme(theme));
  const payload = codec.compress ? await codec.compress(json) : json;
  return `${SHARE_CODE_PREFIX}${SHARE_CODE_VERSION}:${bytesToBase64Url(payload)}`;
}

export async function decodeShareCode(code: string, codec: Codec = platformCodec()): Promise<ThemeImportResult> {
  const text = code.trim();
  // base64url grows data by 4/3; anything longer cannot hold an allowed payload.
  if (text.length > SHARE_CODE_PREFIX.length + 4 + Math.ceil((MAX_THEME_BYTES * 4) / 3)) {
    return fail("the code is larger than 8 KB");
  }
  if (!text.startsWith(SHARE_CODE_PREFIX)) return fail('a theme code starts with "omnirush-theme:1:"');
  const rest = text.slice(SHARE_CODE_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon < 0) return fail('a theme code starts with "omnirush-theme:1:"');
  if (rest.slice(0, colon) !== String(SHARE_CODE_VERSION)) return fail("unsupported theme code version (expected 1)");
  const bytes = base64UrlToBytes(rest.slice(colon + 1));
  if (!bytes || bytes.length === 0) return fail("the code is damaged (not base64url)");
  if (bytes.length > MAX_THEME_BYTES) return fail("the code is larger than 8 KB");

  // Plain JSON payload (written where compression is unavailable) starts with "{".
  if (bytes[0] === 0x7b) {
    const plain = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const parsed = parseThemeJson(plain);
    if (parsed.ok || !codec.decompress) return parsed;
  }
  if (!codec.decompress) return fail("the code is compressed and this app cannot read it");
  const inflated = await codec.decompress(bytes, MAX_THEME_BYTES);
  if (inflated === null) return fail("the theme is larger than 8 KB once decoded");
  if (inflated.length === 0) return fail("the code is damaged (cannot be decompressed)");
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(inflated);
  } catch {
    return fail("the code is damaged (not text)");
  }
  return parseThemeJson(json);
}
