import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunCommand } from "./run.js";
import { classifySetup, elevatedCommand, linuxAllow, linuxAllowScript, readSetupState, runOnceArgs, setupDone, windowsInstall } from "./setup.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temp(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `omnirush-boxsetup-${name}-`));
  dirs.push(dir);
  return dir;
}

const fail = (reason: string, tried: string[] = []) => ({ ok: false as const, reason, tried: tried.map((r) => ({ reason: r })) });
const facts = { build: 22631, hypervisorPresent: false, firmwareEnabled: true, model: "Dell Inc. XPS", sMode: false };

describe("sandbox setup: what is needed", () => {
  test("Linux: AppArmor is the one-click allow; a container without user namespaces cannot run; otherwise the usual next step", () => {
    expect(classifySetup({ runtime: fail("no backend", ["bubblewrap is blocked; one-time admin fix: `sudo omnirush sandbox enable` (OmniRush CLI)"]), platform: "linux", fallback: "native" }).need).toBe("linux_allow");
    expect(classifySetup({ runtime: fail("unprivileged user namespaces are off; an admin can allow them, or use Podman or Docker"), platform: "linux", fallback: "native" })).toMatchObject({ need: "cannot_run", why: null });
    expect(classifySetup({ runtime: fail("podman not found"), platform: "linux", fallback: "native" }).need).toBe("runtime");
    expect(classifySetup({ runtime: { ok: true, name: "docker", bin: "docker", version: "1", os: "linux", arch: "amd64", rootless: true, flavor: "", vm: false }, platform: "linux", fallback: "native", state: { declinedAt: 1 } })).toMatchObject({ need: "none", declined: false });
  });

  test("Windows: install, restart after the install, update, and the cannot-run reasons", () => {
    const off = fail("WSL 2 is not enabled on this Windows. One time, in an administrator terminal: `wsl --install --no-distribution`, then restart Windows");
    expect(classifySetup({ runtime: off, platform: "win32", facts, fallback: "native" }).need).toBe("win_install");
    expect(classifySetup({ runtime: off, platform: "win32", facts, fallback: "native", state: { win: { state: "installed", at: 1, message: "ok" } } })).toMatchObject({ need: "win_restart", result: { ok: true } });
    expect(classifySetup({ runtime: fail("WSL needs an update (`wsl --update`)"), platform: "win32", facts, fallback: "native" }).need).toBe("win_update");
    expect(classifySetup({ runtime: off, platform: "win32", facts: { ...facts, firmwareEnabled: false }, fallback: "native_uncounted" })).toMatchObject({ need: "cannot_run", why: "firmware_off", fallback: "native_uncounted" });
    expect(classifySetup({ runtime: off, platform: "win32", facts: { ...facts, firmwareEnabled: false, model: "Microsoft Corporation Virtual Machine" }, fallback: "native" }).why).toBe("nested_vm");
    expect(classifySetup({ runtime: off, platform: "win32", facts: { ...facts, sMode: true }, fallback: "native" }).whyText).toBe("Windows in S mode can't run WSL");
    expect(classifySetup({ runtime: off, platform: "win32", facts, fallback: "native", state: { win: { state: "failed", at: 1, message: "Installation blocked by group policy" } } }).why).toBe("policy");
    expect(classifySetup({ runtime: off, platform: "win32", facts, fallback: "native", state: { declinedAt: 5 } })).toMatchObject({ need: "win_install", declined: true });
  });

  test("the elevated start is one Start-Process -Verb RunAs -Wait with the .ps1 and its log; RunOnce reopens the app", () => {
    const cmd = elevatedCommand("C:\\Users\\o'neil\\AppData\\Local\\Temp\\s\\setup.ps1", "C:\\Users\\o'neil\\.omnirush\\box\\setup-wsl.log");
    expect(cmd.match(/Start-Process/g)?.length).toBe(1);
    expect(cmd).toContain("-Verb RunAs -Wait -PassThru");
    expect(cmd).toContain(`'"C:\\Users\\o''neil\\AppData\\Local\\Temp\\s\\setup.ps1"'`);
    expect(cmd).toContain("exit 1223");
    expect(runOnceArgs("C:\\Program Files\\OmniRush.ai\\OmniRush.ai.exe")).toEqual(["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce", "/v", "OmniRushSandboxSetup", "/t", "REG_SZ", "/d", "\"C:\\Program Files\\OmniRush.ai\\OmniRush.ai.exe\"", "/f"]);
  });

  test("windows install: done in the log is installed (RunOnce set), a cancelled prompt is declined", async () => {
    const home = await temp("home");
    const calls: string[] = [];
    const ok: RunCommand = async (bin, args) => {
      calls.push(bin);
      if (bin === "powershell.exe") {
        const log = /'"([^"]+setup-wsl\.log)"'/.exec(args.join(" "))?.[1];
        if (log) await writeFile(log, "Installing: Virtual Machine Platform\r\nThe requested operation is successful.\r\ndone\r\n");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const step = await windowsInstall({ home, run: ok, exe: "C:\\App\\OmniRush.ai.exe", tmp: await temp("tmp") });
    expect(step).toMatchObject({ state: "installed", message: "The requested operation is successful." });
    expect(calls).toEqual(["powershell.exe", "reg.exe"]);
    expect(readSetupState(home).win?.state).toBe("installed");
    const cancelled: RunCommand = async () => ({ code: 1223, stdout: "cancelled\n", stderr: "" });
    expect((await windowsInstall({ home, run: cancelled, exe: null, tmp: await temp("tmp") })).state).toBe("declined");
    expect(readSetupState(home).declinedAt).toBeGreaterThan(0);
    const removed: string[] = [];
    await setupDone(home, { platform: "win32", run: async (bin, args) => { removed.push(`${bin} ${args[0]}`); return { code: 0, stdout: "", stderr: "" }; } });
    expect(removed).toEqual(["reg.exe delete"]);
    expect(readSetupState(home)).toEqual({});
  });

  test("Linux allow: pkexec runs the enable step with the staged bubblewrap and its sha256; dismissed is declined", async () => {
    const home = await temp("home");
    const source = join(await temp("bin"), "bwrap");
    await writeFile(source, "fake bwrap");
    const seen: string[][] = [];
    const ok: RunCommand = async (bin, args) => {
      seen.push([bin, ...args]);
      expect(await readFile(args[4] ?? "", "utf8")).toBe("fake bwrap");
      return { code: 0, stdout: "installed; AppArmor profile loaded\n", stderr: "" };
    };
    expect(await linuxAllow({ home, env: {}, run: ok, source })).toMatchObject({ state: "allowed", message: "Allowed (installed; AppArmor profile loaded)." });
    expect(seen[0]?.slice(0, 2)).toEqual(["pkexec", "/bin/sh"]);
    expect(seen[0]?.[6]).toMatch(/^[0-9a-f]{64}$/);
    expect(await linuxAllow({ home, env: { OMNIRUSH_BOX_PKEXEC: "/rig/elevate" }, run: async (bin) => ({ code: bin === "/rig/elevate" ? 126 : 1, stdout: "", stderr: "" }), source })).toMatchObject({ state: "declined" });
    expect(readSetupState(home).declinedAt).toBeGreaterThan(0);
    expect((await linuxAllow({ home, env: {}, run: async () => ({ code: 127, stdout: "", stderr: "Error executing command as another user: Not authorized" }), source })).message).toBe("Not authorised: Error executing command as another user: Not authorized.");
  });

  test("the root step installs only OmniRush's bubblewrap copy and its own AppArmor profile", () => {
    const script = linuxAllowScript();
    expect(script).toContain("dst=/usr/local/lib/omnirush/bwrap; prof=/etc/apparmor.d/omnirush-bwrap");
    expect(script).toContain('chown 0:0 "$dst.tmp"');
    expect(script).toContain("profile omnirush-bwrap /usr/local/lib/omnirush/bwrap flags=(unconfined)");
    expect(script).toContain('"$parser" -r "$prof"');
    expect(script).not.toContain("sysctl");
  });
});
