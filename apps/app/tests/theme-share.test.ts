import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { THEME_PRESETS } from "../src/app/themes/presets";
import {
  MAX_THEME_BYTES,
  base64UrlToBytes,
  bytesToBase64Url,
  decodeShareCode,
  encodeShareCode,
  parseThemeJson,
  serializeTheme,
  themeFileName,
  validateThemeData,
  type Codec,
} from "../src/app/themes/share";
import type { CustomTheme } from "../src/app/themes/types";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function sampleTheme(): CustomTheme {
  const rose = THEME_PRESETS.find((preset) => preset.id === "rose")!;
  return {
    v: 1,
    name: "My theme",
    modes: ["light", "dark"],
    light: clone(rose.variants.light!),
    dark: clone(rose.variants.dark!),
    radiusPx: 7,
    fontSizePx: 13,
  };
}

const raw = () => JSON.parse(serializeTheme(sampleTheme())) as Record<string, any>;

function expectError(input: unknown, fragment: string) {
  const result = validateThemeData(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(fragment);
}

const plainCodec: Codec = { compress: null, decompress: null };

describe("validateThemeData", () => {
  test("accepts a full theme and normalises colours to lower case", () => {
    const doc = raw();
    doc.light.accent = "#C2185B";
    const result = validateThemeData(doc);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.theme.light!.accent).toBe("#c2185b");
      expect(result.theme.modes).toEqual(["light", "dark"]);
    }
  });

  test("accepts every preset variant as a single-mode theme", () => {
    for (const preset of THEME_PRESETS) {
      for (const mode of ["light", "dark"] as const) {
        const variant = preset.variants[mode];
        if (!variant) continue;
        const result = validateThemeData({ v: 1, name: preset.name, modes: [mode], [mode]: variant });
        expect(result.ok).toBe(true);
      }
    }
  });

  test("rejects non-objects", () => {
    expectError(null, "JSON object");
    expectError([], "JSON object");
    expectError("theme", "JSON object");
    expectError(42, "JSON object");
  });

  test("rejects unknown top-level keys", () => {
    expectError({ ...raw(), fontFamily: "Comic Sans" }, 'unknown key "fontFamily"');
    expectError({ ...raw(), css: "body{}" }, 'unknown key "css"');
  });

  test("rejects __proto__ and constructor keys", () => {
    expectError(JSON.parse(`{"v":1,"name":"x","modes":["light"],"__proto__":{"polluted":true}}`), 'unknown key "__proto__"');
    const doc = raw();
    doc.light.constructor = "#000000";
    expectError(doc, 'unknown key "constructor"');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("rejects unknown keys inside variants and groups", () => {
    const a = raw();
    a.dark.shadow = "#000000";
    expectError(a, 'unknown key "shadow" in dark');
    const b = raw();
    b.light.code.decorator = "#000000";
    expectError(b, 'unknown key "decorator" in light.code');
    const c = raw();
    c.light.terminal.selection = "#000000";
    expectError(c, 'unknown key "selection" in light.terminal');
  });

  test("requires version 1", () => {
    expectError({ ...raw(), v: 2 }, "version");
    expectError({ ...raw(), v: "1" }, "version");
    const { v: _v, ...rest } = raw();
    expectError(rest, "version");
  });

  test("checks the name", () => {
    expectError({ ...raw(), name: 5 }, "name");
    expectError({ ...raw(), name: "   " }, "empty");
    expectError({ ...raw(), name: "x".repeat(41) }, "longer than 40");
    expectError({ ...raw(), name: "bad\u0000name" }, "cannot be shown");
    expectError({ ...raw(), name: "rtl‮override" }, "cannot be shown");
    expectError({ ...raw(), name: "zero​width" }, "cannot be shown");
    expectError({ ...raw(), name: "new\nline" }, "cannot be shown");
    const ok = validateThemeData({ ...raw(), name: "  Moss été <b>bold</b>  " });
    expect(ok.ok && ok.theme.name).toBe("Moss été <b>bold</b>");
    expect(validateThemeData({ ...raw(), name: "x".repeat(40) }).ok).toBe(true);
  });

  test("checks modes against the versions present", () => {
    expectError({ ...raw(), modes: [] }, "modes");
    expectError({ ...raw(), modes: "light" }, "modes");
    expectError({ ...raw(), modes: ["light", "light"] }, "twice");
    expectError({ ...raw(), modes: ["light", "sepia"] }, '"light" and "dark"');
    expectError({ ...raw(), modes: ["light", "dark", "light"] }, "modes");
    const { dark: _dark, ...lightOnly } = raw();
    expectError({ ...lightOnly, modes: ["light", "dark"] }, "no dark version");
    expectError({ ...raw(), modes: ["light"] }, "does not list it");
    const ok = validateThemeData({ ...lightOnly, modes: ["light"] });
    expect(ok.ok && ok.theme.modes).toEqual(["light"]);
  });

  test("every colour must be exactly #rrggbb", () => {
    for (const bad of ["#fff", "#ffff", "#fffffff", "#ffffff00", "red", "ffffff", "#gggggg", " #ffffff", "rgb(0,0,0)", 123, null]) {
      const doc = raw();
      doc.light.background = bad;
      expectError(doc, '"light.background" must be a colour');
    }
    const doc = raw();
    doc.dark.terminal.brightCyan = "#12345";
    expectError(doc, '"dark.terminal.brightCyan" must be a colour');
  });

  test("CSS injection attempts are rejected", () => {
    const attempts = [
      "red;}body{display:none",
      "#ffffff;}body{display:none}",
      "#fff;background:url(x)",
      "var(--x)",
      "expression(alert(1))",
      "#ffffff !important",
      "#ffffff\n}",
    ];
    for (const value of attempts) {
      const doc = raw();
      doc.light.accent = value;
      expectError(doc, "must be a colour");
      const doc2 = raw();
      doc2.dark.code.keyword = value;
      expectError(doc2, "must be a colour");
    }
    expectError({ ...raw(), radiusPx: "4px;}body{display:none" }, "radiusPx");
  });

  test("requires every colour", () => {
    const a = raw();
    delete a.light.textMuted;
    expectError(a, 'missing colour "light.textMuted"');
    const b = raw();
    delete b.dark.code.comment;
    expectError(b, 'missing colour "dark.code.comment"');
    const c = raw();
    delete c.dark.terminal.cursor;
    expectError(c, 'missing colour "dark.terminal.cursor"');
    const d = raw();
    d.light.code = "#ffffff";
    expectError(d, '"light.code" must be an object');
  });

  test("highlight is optional but must be a colour", () => {
    const a = raw();
    delete a.light.highlight;
    expect(validateThemeData(a).ok).toBe(true);
    const b = raw();
    b.light.highlight = "lime";
    expectError(b, "light.highlight");
  });

  test("clamps radius and font size and defaults them", () => {
    const big = validateThemeData({ ...raw(), radiusPx: 400, fontSizePx: 99 });
    expect(big.ok && [big.theme.radiusPx, big.theme.fontSizePx]).toEqual([16, 16]);
    const small = validateThemeData({ ...raw(), radiusPx: -3, fontSizePx: 2 });
    expect(small.ok && [small.theme.radiusPx, small.theme.fontSizePx]).toEqual([0, 12]);
    const { radiusPx: _r, fontSizePx: _f, ...rest } = raw();
    const defaults = validateThemeData(rest);
    expect(defaults.ok && [defaults.theme.radiusPx, defaults.theme.fontSizePx]).toEqual([7.2, 13]);
    expectError({ ...raw(), radiusPx: Number.NaN }, "radiusPx");
    expectError({ ...raw(), fontSizePx: "14" }, "fontSizePx");
    expectError({ ...raw(), fontSizePx: null }, "fontSizePx");
  });

  test("never carries strings other than name and colours", () => {
    const result = validateThemeData(raw());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const strings: string[] = [];
    const walk = (value: unknown, key: string) => {
      if (typeof value === "string" && key !== "name" && key !== "modes") strings.push(value);
      else if (Array.isArray(value)) value.forEach((item) => walk(item, "modes"));
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
    };
    walk(result.theme, "");
    expect(strings.every((value) => /^#[0-9a-f]{6}$/.test(value))).toBe(true);
  });
});

describe("parseThemeJson", () => {
  test("round-trips through the file format", () => {
    const theme = sampleTheme();
    const result = parseThemeJson(serializeTheme(theme, true));
    expect(result.ok && result.theme).toEqual(theme);
  });

  test("rejects garbage and oversize text", () => {
    expect(parseThemeJson("not json").ok).toBe(false);
    expect(parseThemeJson("").ok).toBe(false);
    const big = parseThemeJson(JSON.stringify({ ...raw(), pad: "x".repeat(MAX_THEME_BYTES) }));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toContain("8 KB");
  });

  test("a full two-mode theme fits well under the cap", () => {
    expect(new TextEncoder().encode(serializeTheme(sampleTheme())).length).toBeLessThan(MAX_THEME_BYTES / 2);
  });

  test("file names are safe slugs", () => {
    expect(themeFileName({ name: "My theme" })).toBe("my-theme.omnirush-theme.json");
    expect(themeFileName({ name: "../../etc/passwd" })).toBe("etc-passwd.omnirush-theme.json");
    expect(themeFileName({ name: "???" })).toBe("theme.omnirush-theme.json");
  });
});

describe("share codes", () => {
  test("round-trip with compression", async () => {
    const theme = sampleTheme();
    const code = await encodeShareCode(theme);
    expect(code.startsWith("omnirush-theme:1:")).toBe(true);
    expect(code.slice("omnirush-theme:1:".length)).toMatch(/^[A-Za-z0-9_-]+$/);
    const result = await decodeShareCode(`  ${code}\n`);
    expect(result.ok && result.theme).toEqual(theme);
  });

  test("compressed codes are shorter than plain ones", async () => {
    const theme = sampleTheme();
    const compressed = await encodeShareCode(theme);
    const plain = await encodeShareCode(theme, plainCodec);
    expect(compressed.length).toBeLessThan(plain.length);
  });

  test("plain base64url JSON codes decode with or without compression support", async () => {
    const theme = sampleTheme();
    const code = await encodeShareCode(theme, plainCodec);
    expect((await decodeShareCode(code)).ok).toBe(true);
    const plainOnly = await decodeShareCode(code, plainCodec);
    expect(plainOnly.ok && plainOnly.theme).toEqual(theme);
  });

  test("decodes codes made by another deflate-raw implementation", async () => {
    const payload = deflateRawSync(Buffer.from(serializeTheme(sampleTheme())));
    const code = `omnirush-theme:1:${bytesToBase64Url(new Uint8Array(payload))}`;
    const result = await decodeShareCode(code);
    expect(result.ok).toBe(true);
  });

  test("rejects a wrong prefix or version", async () => {
    for (const [code, fragment] of [
      ["", "starts with"],
      ["theme:1:abc", "starts with"],
      ["omnirush-theme:", "starts with"],
      ["omnirush-theme:2:abcd", "version"],
      ["omnirush-theme:x:abcd", "version"],
    ] as const) {
      const result = await decodeShareCode(code);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(fragment);
    }
  });

  test("rejects garbage base64", async () => {
    for (const payload of ["", "!!!!", "abc$def", "a", "ab+cd/==", "%%%"]) {
      const result = await decodeShareCode(`omnirush-theme:1:${payload}`);
      expect(result.ok).toBe(false);
    }
  });

  test("rejects payloads that decode to garbage", async () => {
    const random = bytesToBase64Url(new Uint8Array([1, 2, 3, 250, 251, 252, 9, 9, 9]));
    expect((await decodeShareCode(`omnirush-theme:1:${random}`)).ok).toBe(false);
    const notJson = bytesToBase64Url(new Uint8Array(deflateRawSync(Buffer.from("hello world"))));
    expect((await decodeShareCode(`omnirush-theme:1:${notJson}`)).ok).toBe(false);
    const badUtf8 = bytesToBase64Url(new Uint8Array(deflateRawSync(Buffer.from([0xff, 0xfe, 0xfd]))));
    expect((await decodeShareCode(`omnirush-theme:1:${badUtf8}`)).ok).toBe(false);
  });

  test("validates the decoded theme (unknown key, bad colour, injection)", async () => {
    const cases: Array<[Record<string, any>, string]> = [];
    cases.push([{ ...raw(), fontFamily: "x" }, 'unknown key "fontFamily"']);
    const badColour = raw();
    badColour.light.accent = "#12";
    cases.push([badColour, "must be a colour"]);
    const injection = raw();
    injection.dark.background = "red;}body{display:none";
    cases.push([injection, "must be a colour"]);
    for (const [doc, fragment] of cases) {
      const payload = deflateRawSync(Buffer.from(JSON.stringify(doc)));
      const result = await decodeShareCode(`omnirush-theme:1:${bytesToBase64Url(new Uint8Array(payload))}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(fragment);
    }
  });

  test("rejects oversize codes before decoding", async () => {
    const huge = `omnirush-theme:1:${"A".repeat(20_000)}`;
    const result = await decodeShareCode(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("8 KB");
    const plain = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ ...raw(), pad: "x".repeat(7000) })));
    const plainResult = await decodeShareCode(`omnirush-theme:1:${plain}`);
    expect(plainResult.ok).toBe(false);
  });

  test("stops decompression bombs at 8 KB", async () => {
    // 2 MB of spaces compresses to a few KB; the decoder must stop at the cap.
    const bomb = deflateRawSync(Buffer.from(`{"v":1,"name":"x","modes":["light"]${" ".repeat(2_000_000)}}`), { level: 9 });
    expect(bomb.length).toBeLessThan(MAX_THEME_BYTES);
    const result = await decodeShareCode(`omnirush-theme:1:${bytesToBase64Url(new Uint8Array(bomb))}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("8 KB once decoded");
  });

  test("the decompressor reads no more than the cap", async () => {
    let seen = 0;
    const codec: Codec = {
      compress: null,
      decompress: async (bytes, limit) => {
        const inflated = (await import("node:zlib")).inflateRawSync(Buffer.from(bytes));
        seen = limit;
        return inflated.length > limit ? null : new Uint8Array(inflated);
      },
    };
    const bomb = deflateRawSync(Buffer.from(" ".repeat(100_000)));
    const result = await decodeShareCode(`omnirush-theme:1:${bytesToBase64Url(new Uint8Array(bomb))}`, codec);
    expect(result.ok).toBe(false);
    expect(seen).toBe(MAX_THEME_BYTES);
  });

  test("base64url helpers round-trip all byte values", () => {
    const bytes = new Uint8Array(256).map((_, index) => index);
    expect(Array.from(base64UrlToBytes(bytesToBase64Url(bytes))!)).toEqual(Array.from(bytes));
    expect(base64UrlToBytes("a+b/")).toBeNull();
  });
});
