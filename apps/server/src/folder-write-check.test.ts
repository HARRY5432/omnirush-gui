import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkFolderWritable,
  classifyFailure,
  controlledFolderAccessOn,
  folderWriteGate,
  probeInProcess,
  readOnlyPrompt,
  resetFolderWriteGate,
  type FolderProbeOutcome,
} from "./folder-write-check.js";

const fail = (code: string | null, message = "", step = "create"): Extract<FolderProbeOutcome, { ok: false }> => ({ ok: false, step, code, errno: null, message });

const winEnv = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  SystemRoot: "C:\\Windows",
  ProgramData: "C:\\ProgramData",
  OneDrive: "C:\\Users\\sam\\OneDrive",
};

afterEach(() => resetFolderWriteGate());

describe("classifyFailure", () => {
  test("POSIX codes", () => {
    expect(classifyFailure(fail("EACCES"), { platform: "linux", dir: "/srv/x" })).toBe("permission");
    expect(classifyFailure(fail("EPERM"), { platform: "linux", dir: "/srv/x" })).toBe("permission");
    expect(classifyFailure(fail("EROFS"), { platform: "linux", dir: "/mnt/ro" })).toBe("read_only_volume");
    expect(classifyFailure(fail("ENOSPC", "", "write"), { platform: "linux", dir: "/x" })).toBe("disk_full");
    expect(classifyFailure(fail("ENOENT"), { platform: "linux", dir: "/gone" })).toBe("missing");
    expect(classifyFailure(fail("EIO"), { platform: "linux", dir: "/x" })).toBe("unknown");
  });

  test("macOS privacy-protected folders and volumes", () => {
    const ctx = { platform: "darwin" as const, home: "/Users/sam" };
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "/Users/sam/Desktop/proj" })).toBe("macos_privacy");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "/Users/sam/Documents" })).toBe("macos_privacy");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "/Users/sam/Downloads/a" })).toBe("macos_privacy");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "/Volumes/USB/proj" })).toBe("macos_privacy");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "/Users/sam/code" })).toBe("permission");
    expect(classifyFailure(fail("EACCES"), { ...ctx, dir: "/Users/sam/Desktop" })).toBe("permission");
    expect(classifyFailure(fail("EROFS"), { ...ctx, dir: "/Volumes/dmg" })).toBe("read_only_volume");
  });

  test("Windows: Controlled folder access, system folders, read-only attribute, OneDrive, UNC", () => {
    const ctx = { platform: "win32" as const, env: winEnv };
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "C:\\Users\\sam\\Documents\\OmniRushTest", cfaOn: true })).toBe("protected_folder");
    expect(classifyFailure(fail("EACCES"), { ...ctx, dir: "C:\\Users\\sam\\Desktop\\x", cfaOn: true })).toBe("protected_folder");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "C:\\Program Files\\Thing" })).toBe("system_folder");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "c:\\windows\\system32" })).toBe("system_folder");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "C:\\" })).toBe("system_folder");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "D:\\proj", readOnlyMode: true })).toBe("read_only_attribute");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "D:\\proj" })).toBe("permission");
    expect(classifyFailure(fail("UNKNOWN", "UNKNOWN: unknown error, open"), { ...ctx, dir: "C:\\Users\\sam\\OneDrive\\proj" })).toBe("cloud_files");
    expect(classifyFailure(fail("UNKNOWN", "The cloud file provider is not running."), { ...ctx, dir: "D:\\sync\\proj" })).toBe("cloud_files");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "C:\\Users\\sam\\OneDrive\\proj" })).toBe("cloud_files");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "C:\\Users\\sam\\OneDrive\\proj", cfaOn: true })).toBe("protected_folder");
    expect(classifyFailure(fail("EACCES"), { ...ctx, dir: "\\\\nas\\share\\proj" })).toBe("network_folder");
    expect(classifyFailure(fail("EROFS"), { ...ctx, dir: "E:\\" })).toBe("read_only_volume");
  });
});

describe("controlledFolderAccessOn", () => {
  test("block mode only (1), not audit (2) or off (0)", async () => {
    const out = (value: string) => async () => `\r\n    EnableControlledFolderAccess    REG_DWORD    ${value}\r\n`;
    expect(await controlledFolderAccessOn(out("0x1"))).toBe(true);
    expect(await controlledFolderAccessOn(out("0x2"))).toBe(false);
    expect(await controlledFolderAccessOn(out("0x0"))).toBe(false);
    expect(await controlledFolderAccessOn(async () => { throw new Error("not found"); })).toBe(false);
  });
});

describe("checkFolderWritable", () => {
  test("a writable folder passes and leaves nothing behind", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fwc-"));
    try {
      expect(probeInProcess(dir)).toEqual({ ok: true });
      expect(await checkFolderWritable(dir, { engineBin: null })).toEqual({ ok: true, via: "server" });
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a read-only folder fails with permission and the fix", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fwc-ro-"));
    chmodSync(dir, 0o555);
    try {
      const result = await checkFolderWritable(dir, { engineBin: null });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("permission");
      expect(result.code).toBe("EACCES");
      expect(result.message).toBe(`OmniRush can't write to ${dir}: permission denied (EACCES).`);
      expect(result.hint).toContain("chown");
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("simulated Windows Controlled folder access names the engine to allow", async () => {
    const engine = "C:\\Program Files\\OmniRush\\resources\\sidecars\\opencode.exe";
    const result = await checkFolderWritable("C:\\Users\\sam\\Documents\\OmniRushTest", {
      platform: "win32",
      env: winEnv,
      engineBin: engine,
      probeEngine: async () => fail("EPERM", "EPERM: operation not permitted, open"),
      cfa: async () => true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.via).toBe("engine");
    expect(result.reason).toBe("protected_folder");
    expect(result.message).toContain("Controlled folder access");
    expect(result.hint).toContain(engine);
  });

  test("simulated EROFS", async () => {
    const result = await checkFolderWritable("/mnt/ro", { platform: "linux", engineBin: "/x/opencode", probeEngine: async () => fail("EROFS") });
    expect(result.ok ? null : result.reason).toBe("read_only_volume");
  });

  test("the engine probe not running falls back to this process", async () => {
    let local = 0;
    const result = await checkFolderWritable("/x", { engineBin: "/x/opencode", probeEngine: async () => null, probeLocal: () => { local += 1; return { ok: true }; } });
    expect(result).toEqual({ ok: true, via: "server" });
    expect(local).toBe(1);
  });
});

describe("folderWriteGate", () => {
  test("once per chat and folder after a pass; again at every prompt after a failure", async () => {
    let probes = 0;
    let ok = false;
    const options = { engineBin: "/x/opencode", probeEngine: async (): Promise<FolderProbeOutcome> => { probes += 1; return ok ? { ok: true } : fail("EACCES"); }, platform: "linux" as const };
    expect((await folderWriteGate("ses_1", "/p", options))?.reason).toBe("permission");
    expect((await folderWriteGate("ses_1", "/p", options))?.reason).toBe("permission");
    expect(probes).toBe(2);
    ok = true;
    expect(await folderWriteGate("ses_1", "/p", options)).toBeNull();
    expect(await folderWriteGate("ses_1", "/p", options)).toBeNull();
    expect(probes).toBe(3);
    // Another folder for the same chat is checked.
    expect(await folderWriteGate("ses_1", "/q", options)).toBeNull();
    expect(probes).toBe(4);
  });

  test("OMNIRUSH_WRITE_CHECK=off skips it", async () => {
    expect(await folderWriteGate("ses_2", "/p", { env: { OMNIRUSH_WRITE_CHECK: "off" }, probeEngine: async () => fail("EACCES"), engineBin: "/x" })).toBeNull();
  });

  test("plan-agent prompts are read-only", () => {
    expect(readOnlyPrompt({ agent: "plan", parts: [] })).toBe(true);
    expect(readOnlyPrompt({ agent: "build" })).toBe(false);
    expect(readOnlyPrompt({})).toBe(false);
    expect(readOnlyPrompt(null)).toBe(false);
  });
});
