import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunCommand } from "./run.js";
import { classifySetup, elevatedArgs, linuxAllow, linuxAllowScript, parseInstallLog, recentlyDeclined, resumeWinSetup, runOnceArgs, saveSetupState, setupDecision, setupState, windowsBuild, windowsInstall } from "./setup.js";

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
const checks = { build: 22631, hypervisor: false, firmware: true, model: "Dell Inc. XPS", s_mode: false };
const OFF = "WSL 2 is not enabled on this Windows. One time, in an administrator terminal: `wsl --install --no-distribution`, then restart Windows";
const ok: Awaited<ReturnType<RunCommand>> = { code: 0, stdout: "", stderr: "" };

describe("sandbox setup: what is needed", () => {
  test("Linux: AppArmor is the one-click allow; a container without user namespaces cannot run; otherwise the usual next step", () => {
    expect(classifySetup({ runtime: fail("no backend", ["bubblewrap is blocked; one-time admin fix: Allow the sandbox (one password prompt), or `sudo omnirush sandbox enable` (OmniRush CLI)"]), platform: "linux", fallback: "native" }).need).toBe("linux_allow");
    expect(classifySetup({ runtime: fail("unprivileged user namespaces are off; an admin can allow them, or use Podman or Docker"), platform: "linux", fallback: "native" })).toMatchObject({ need: "cannot_run", why: null });
    expect(classifySetup({ runtime: fail("podman not found"), platform: "linux", fallback: "native" }).need).toBe("runtime");
    const docker = { ok: true as const, name: "docker", bin: "docker", version: "1", os: "linux", arch: "amd64", rootless: true, flavor: "", vm: false };
    expect(classifySetup({ runtime: docker, platform: "linux", fallback: "native", state: { linux: { state: "declined", at: Date.now() } } })).toMatchObject({ need: "none", declined: false });
  });

  test("Windows: install, restart after it, update, and the cannot-run reasons", () => {
    expect(classifySetup({ runtime: fail(OFF), platform: "win32", checks, fallback: "native" }).need).toBe("win_install");
    expect(classifySetup({ runtime: fail(OFF), platform: "win32", checks, fallback: "native", state: { win: { state: "restart", message: "WSL 2 is installed.", at: 1 } } })).toMatchObject({ need: "win_restart", result: { ok: true } });
    expect(classifySetup({ runtime: fail("WSL needs an update (`wsl --update`)"), platform: "win32", checks, fallback: "native" }).need).toBe("win_update");
    expect(classifySetup({ runtime: fail(OFF), platform: "win32", checks: { ...checks, firmware: false }, fallback: "native_uncounted" })).toMatchObject({ need: "cannot_run", why: "firmware_off", fallback: "native_uncounted" });
    expect(classifySetup({ runtime: fail(OFF), platform: "win32", checks: { ...checks, firmware: false, model: "Microsoft Corporation Virtual Machine" }, fallback: "native" }).why).toBe("nested_vm");
    expect(classifySetup({ runtime: fail(OFF), platform: "win32", checks: { ...checks, hypervisor: true, firmware: false }, fallback: "native" }).need).toBe("win_install");
    expect(classifySetup({ runtime: fail(OFF), platform: "win32", checks: { ...checks, s_mode: true }, fallback: "native" }).whyText).toBe("Windows in S mode can't run WSL");
    expect(classifySetup({ runtime: fail(OFF), platform: "win32", checks, fallback: "native", state: { win: { state: "blocked", why: "policy", at: 1 } } }).why).toBe("policy");
    expect(classifySetup({ runtime: fail(OFF), platform: "win32", checks, fallback: "native", state: { win: { state: "declined", at: Date.now() } } })).toMatchObject({ need: "win_install", declined: true });
    expect(classifySetup({ runtime: fail(OFF), platform: "win32", checks, fallback: "native", state: { win: { state: "declined", at: 1 } } }).declined).toBe(false);
    expect(classifySetup({ runtime: fail("no backend"), platform: "darwin", fallback: "native", release: "21.6.0" }).why).toBe("old_macos");
    expect(classifySetup({ runtime: fail("no backend"), platform: "darwin", fallback: "native", release: "24.1.0", macVm: true }).need).toBe("mac_vm");
  });

  test("the CLI's checks: build, S mode, a running hypervisor passes, firmware off, a VM guest; the install log", () => {
    expect(windowsBuild("10.0.19045")).toBe(19045);
    expect(setupDecision({ ...checks, build: 18363 })).toEqual({ ok: false, why: "old_windows" });
    expect(setupDecision({ ...checks, s_mode: true })).toEqual({ ok: false, why: "s_mode" });
    expect(setupDecision({ ...checks, hypervisor: true, firmware: false })).toEqual({ ok: true });
    expect(setupDecision({ ...checks, firmware: false, model: "innotek GmbH VirtualBox" })).toEqual({ ok: false, why: "nested_vm" });
    expect(setupDecision(null)).toEqual({ ok: true });
    expect(parseInstallLog("\uFEFFInstalling\r\nThe operation completed successfully.\r\ndone\r\n")).toEqual({ result: "installed" });
    expect(parseInstallLog("Error: 0x80370102 Please enable the Virtual Machine Platform\r\ndone")).toEqual({ result: "blocked", why: "firmware_off" });
    expect(parseInstallLog("This feature is blocked by group policy\r\ndone")).toEqual({ result: "blocked", why: "policy" });
    expect(parseInstallLog("Error: access denied")).toEqual({ result: "failed", line: "Error: access denied" });
  });

  test("the elevated start is one Start-Process -Verb RunAs -Wait with the .ps1 and its log; RunOnce reopens the app", () => {
    const args = elevatedArgs("C:\\Users\\o'neil\\AppData\\Local\\Temp\\s.ps1", "C:\\Users\\o'neil\\AppData\\Local\\Temp\\s.log");
    expect(args.join(" ").match(/Start-Process/g)?.length).toBe(1);
    expect(args.at(-1)).toContain("-Verb RunAs -Wait");
    expect(args.at(-1)).toContain(`-File "C:\\Users\\o''neil\\AppData\\Local\\Temp\\s.ps1" "C:\\Users\\o''neil\\AppData\\Local\\Temp\\s.log"`);
    expect(runOnceArgs("C:\\Program Files\\OmniRush.ai\\OmniRush.ai.exe")).toEqual(["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce", "/v", "OmniRushSandboxSetup", "/t", "REG_SZ", "/d", "\"C:\\Program Files\\OmniRush.ai\\OmniRush.ai.exe\"", "/f"]);
  });

  test("windows install: the shared script in a temp .ps1; done is a restart (RunOnce set); a cancelled prompt is declined; checks first", async () => {
    const home = await temp("home");
    const calls: string[] = [];
    let script = "";
    const run: RunCommand = async (bin, args) => {
      calls.push(bin.split(/[\\/]/).pop() ?? bin);
      const m = /-File "([^"]+)" "([^"]+)"/.exec(args.at(-1) ?? "");
      if (m?.[1] && m[2]) {
        script = await readFile(m[1], "utf8");
        await writeFile(m[2], "Installing: Virtual Machine Platform\r\ndone\r\n");
      }
      return ok;
    };
    const entry = await windowsInstall({ home, env: { SystemRoot: "C:\\Windows" }, run, exe: "C:\\App\\OmniRush.ai.exe", tmpDir: await temp("tmp"), checks });
    expect(entry.state).toBe("restart");
    expect(script).toContain("wsl.exe --install --no-distribution");
    expect(script.endsWith("\r\n")).toBe(true);
    expect(calls).toEqual(["powershell.exe", "reg.exe"]);
    expect(setupState(home).win?.state).toBe("restart");
    const cancelled: RunCommand = async () => ({ code: 1, stdout: "", stderr: "This operation was canceled by the user." });
    expect((await windowsInstall({ home, run: cancelled, exe: null, tmpDir: await temp("tmp"), checks })).state).toBe("declined");
    expect(recentlyDeclined(setupState(home).win)).toBe(true);
    const never: RunCommand = async () => { throw new Error("must not run"); };
    expect(await windowsInstall({ home, run: never, exe: null, tmpDir: await temp("tmp"), checks: { ...checks, s_mode: true } })).toMatchObject({ state: "blocked", why: "s_mode" });
  });

  test("resume after the restart: wsl --update when asked, then the marker and the RunOnce value go", async () => {
    const home = await temp("home");
    saveSetupState(home, "win", { state: "restart" });
    const calls: string[] = [];
    let updated = false;
    const run: RunCommand = async (bin, args) => {
      calls.push(`${bin.split(/[\\/]/).pop()} ${args.slice(0, 2).join(" ")}`);
      if (args[0] === "--status") return { code: updated ? 0 : 1, stdout: updated ? "Default Version: 2" : "WSL needs updating: run wsl --update", stderr: "" };
      if (args[0] === "--update") updated = true;
      return ok;
    };
    expect(await resumeWinSetup({ home, run, bin: "wsl.exe" })).toEqual({ ok: true, state: "ready" });
    expect(calls).toEqual(["wsl.exe --status", "wsl.exe --update --web-download", "wsl.exe --status", "reg.exe delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce"]);
    expect(setupState(home)).toEqual({});
    expect(await resumeWinSetup({ home, run, bin: "wsl.exe" })).toEqual({ ok: false, state: "none" });
  });

  test("Linux allow: pkexec runs the enable step with the staged bubblewrap and its sha256; dismissed is declined", async () => {
    const home = await temp("home");
    const source = join(await temp("bin"), "bwrap");
    await writeFile(source, "fake bwrap");
    const seen: string[][] = [];
    const allowed: RunCommand = async (bin, args) => {
      seen.push([bin, ...args]);
      expect(await readFile(args[4] ?? "", "utf8")).toBe("fake bwrap");
      return { code: 0, stdout: "installed; AppArmor profile loaded\n", stderr: "" };
    };
    saveSetupState(home, "linux", { state: "declined" });
    expect(await linuxAllow({ home, env: {}, run: allowed, source })).toEqual({ ok: true, message: "Allowed (installed; AppArmor profile loaded)." });
    expect(setupState(home)).toEqual({});
    expect(seen[0]?.slice(0, 2)).toEqual(["pkexec", "/bin/sh"]);
    expect(seen[0]?.[6]).toMatch(/^[0-9a-f]{64}$/);
    expect(await linuxAllow({ home, env: { OMNIRUSH_BOX_PKEXEC: "/rig/elevate" }, run: async (bin) => ({ code: bin === "/rig/elevate" ? 126 : 1, stdout: "", stderr: "" }), source })).toMatchObject({ ok: false });
    expect(recentlyDeclined(setupState(home).linux)).toBe(true);
    expect((await linuxAllow({ home, env: {}, run: async () => ({ code: 127, stdout: "", stderr: "Error executing command as another user: Not authorized" }), source })).message).toBe("Not authorised: Error executing command as another user: Not authorized.");
    expect(setupState(home).linux?.state).toBe("failed");
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
