import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import type { RunCommand } from "./run.js";
import { ENABLE_HINT, probeWslDistro, withoutWsl1Notes } from "./backends/wsl.js";
import { RESUME_UPDATE_WAIT_MS, blockedWhy, classifySetup, elevatedArgs, installLogFile, linuxAllow, linuxAllowScript, parseInstallLog, recentlyDeclined, resumeWinSetup, runOnceArgs, saveSetupState, setupDecision, setupState, windowsBuild, windowsInstall } from "./setup.js";
import { REQUIRED_RULES } from "./required.js";

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

// Windows 11 24H2 after `wsl --install --no-distribution` and the restart (seen on the CLI's VM rig, 2026-10-22).
const STATUS_WSL1_NOTE = "Default Version: 2\r\n\r\nWSL1 is not supported with your current machine configuration.\r\nPlease enable the \"Windows Subsystem for Linux\" optional component to use WSL1.\r\n";
// The same PC before the restart (and a PC that cannot start a VM after it).
const STATUS_NO_VM = `${STATUS_WSL1_NOTE}WSL2 is unable to start since virtualization is not enabled on this machine.\r\nPlease ensure the "Virtual Machine Platform" optional component is enabled and virtualization is turned on in your computer's firmware settings.\r\n`;

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
  });

  test("macOS: the OmniRush VM being set up is mac_vm; too old a macOS cannot run; nothing working is the usual next step", () => {
    const vm = { ok: true as const, name: "lima", backend: "lima", bin: "", version: "2.2.1", os: "linux", arch: "arm64", rootless: false, flavor: "omnirush-vm", vm: true, installed: false };
    expect(classifySetup({ runtime: vm, platform: "darwin", fallback: "native", release: "25.0.0", macVm: true })).toMatchObject({ need: "mac_vm", declined: false });
    expect(classifySetup({ runtime: { ...vm, installed: true }, platform: "darwin", fallback: "native", release: "25.0.0" }).need).toBe("none");
    expect(classifySetup({ runtime: fail("no backend"), platform: "darwin", fallback: "native", release: "21.6.0" }).why).toBe("old_macos");
    expect(classifySetup({ runtime: fail("no backend", ["the OmniRush VM needs macOS 13 or later (this is macOS 12)"]), platform: "darwin", fallback: "native", release: "25.0.0" }).why).toBe("old_macos");
    expect(classifySetup({ runtime: fail("no backend", ["the OmniRush VM did not start (vz: not supported)"]), platform: "darwin", fallback: "native", release: "25.0.0", macVm: true }).need).toBe("runtime");
  });

  test("the CLI's checks: build, S mode, a running hypervisor passes, firmware off, a VM guest; the install log", () => {
    expect(windowsBuild("10.0.19045")).toBe(19045);
    expect(setupDecision({ ...checks, build: 18363 })).toEqual({ ok: false, why: "old_windows" });
    expect(setupDecision({ ...checks, s_mode: true })).toEqual({ ok: false, why: "s_mode" });
    expect(setupDecision({ ...checks, hypervisor: true, firmware: false })).toEqual({ ok: true });
    expect(setupDecision({ ...checks, firmware: false, model: "innotek GmbH VirtualBox" })).toEqual({ ok: false, why: "nested_vm" });
    expect(setupDecision(null)).toEqual({ ok: true });
    expect(parseInstallLog("\uFEFFInstalling\r\nThe operation completed successfully.\r\ndone\r\n")).toEqual({ result: "installed" });
    expect(parseInstallLog("Error: 0x80370102 Please enable the Virtual Machine Platform\r\nfailed 1")).toEqual({ result: "blocked", why: "firmware_off" });
    expect(parseInstallLog("This feature is blocked by group policy\r\nfailed 1")).toEqual({ result: "blocked", why: "policy" });
    // wsl --install said "enable the Virtual Machine Platform", the DISM route then turned it on: installed (CLI: the same).
    expect(parseInstallLog("Please enable the Virtual Machine Platform Windows feature and ensure virtualization is enabled in the BIOS.\r\nThe operation completed successfully.\r\ndone\r\n")).toEqual({ result: "installed" });
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
    let scriptPath = "";
    const run: RunCommand = async (bin, args) => {
      calls.push(bin.split(/[\\/]/).pop() ?? bin);
      const m = /-File "([^"]+)" "([^"]+)"/.exec(args.at(-1) ?? "");
      if (m?.[1] && m[2]) {
        scriptPath = m[1];
        script = await readFile(m[1], "utf8");
        await writeFile(m[2], "Installing: Virtual Machine Platform\r\ndone\r\n");
      }
      return ok;
    };
    const tmpDir = await temp("tmp");
    const entry = await windowsInstall({ home, env: { SystemRoot: "C:\\Windows" }, run, exe: "C:\\App\\OmniRush.ai.exe", tmpDir, checks });
    // The script sat in a folder made for this run only (random name), never at a name known in advance; gone after.
    expect(scriptPath.split(/[\\/]/).pop()).toBe("setup.ps1");
    expect(path.basename(path.dirname(scriptPath))).toMatch(/^omnirush-wsl-setup-[A-Za-z0-9]{6}$/);
    expect(path.dirname(path.dirname(scriptPath))).toBe(tmpDir);
    expect(await readdir(tmpDir)).toEqual([]);
    expect(entry.state).toBe("restart");
    expect(script).toContain("Invoke-Native 'wsl.exe' @('--install', '--no-distribution')");
    expect(script).toBe(`${REQUIRED_RULES.setup.win32.install_script.join("\r\n")}\r\n`);
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

  test("resume: a WSL 1 note alone is WSL 2 ready; no VM before the restart waits, after it is blocked with why", async () => {
    const reply = (stdout: string): RunCommand => async () => ({ code: 0, stdout, stderr: "" });
    const home = await temp("home");
    saveSetupState(home, "win", { state: "restart" }, { now: 1_000 });
    expect(await resumeWinSetup({ home, bin: "wsl.exe", bootedAt: 2_000, run: reply(STATUS_WSL1_NOTE) })).toEqual({ ok: true, state: "ready" });
    expect(setupState(home).win).toBeUndefined();
    saveSetupState(home, "win", { state: "restart" }, { now: 5_000 });
    expect((await resumeWinSetup({ home, bin: "wsl.exe", bootedAt: 2_000, now: 6_000, run: reply(STATUS_NO_VM) })).state).toBe("restart");
    expect(setupState(home).win?.state).toBe("restart");
    expect(await resumeWinSetup({ home, bin: "wsl.exe", bootedAt: 7_000, now: 8_000, checks: { model: "QEMU Standard PC (Q35 + ICH9, 2009)" }, run: reply(STATUS_NO_VM) })).toEqual({ ok: false, state: "blocked", why: "nested_vm" });
    expect(setupState(home).win?.why).toBe("nested_vm");
    saveSetupState(home, "win", { state: "restart" }, { now: 5_000 });
    expect((await resumeWinSetup({ home, bin: "wsl.exe", bootedAt: 7_000, checks: { model: "LENOVO 20XW" }, run: reply(STATUS_NO_VM) })).why).toBe("firmware_off");
    // Still off after the restart (the optional component): the marker stays.
    saveSetupState(home, "win", { state: "restart" }, { now: 5_000 });
    expect((await resumeWinSetup({ home, bin: "wsl.exe", bootedAt: 7_000, run: async () => ({ code: 1, stdout: "The Windows Subsystem for Linux optional component is not enabled.\n", stderr: "" }) })).state).toBe("restart");
    // A virtualization error code after the restart on a PC: firmware_off.
    expect(await resumeWinSetup({ home, bin: "wsl.exe", bootedAt: 7_000, checks: { model: "Dell Inc. XPS 13" }, run: async () => ({ code: 1, stdout: "Error code: Wsl/Service/CreateInstance/CreateVm/HCS/HCS_E_HYPERV_NOT_INSTALLED\n", stderr: "" }) })).toEqual({ ok: false, state: "blocked", why: "firmware_off" });
  });

  test("the WSL probe: a WSL 1 note in wsl --status is not \"WSL 2 is not enabled\"", async () => {
    expect(withoutWsl1Notes(STATUS_WSL1_NOTE).trim()).toBe("Default Version: 2");
    const run: RunCommand = async (_bin, args) => (args[0] === "--status" ? { code: 0, stdout: STATUS_WSL1_NOTE, stderr: "" } : ok);
    const probe = await probeWslDistro({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, exists: () => true, run });
    expect(probe.ok ? null : probe.reason).not.toBe(ENABLE_HINT);
    const off = await probeWslDistro({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, exists: () => true, run: async () => ({ code: 0, stdout: STATUS_NO_VM, stderr: "" }) });
    expect(off.ok ? null : off.reason).toBe(ENABLE_HINT);
  });

  test("windows install: the log is kept in the box home; a blocked install in a VM says nested_vm; a failed one names the log", async () => {
    const home = await temp("home");
    const tmpDir = await temp("tmp");
    const install = (log: string): RunCommand => async (_bin, args) => {
      const m = /-File "([^"]+)" "([^"]+)"/.exec((args.at(-1) ?? "").replace(/''/g, "'"));
      if (m?.[2]) await writeFile(m[2], log);
      return ok;
    };
    const vm = { ...checks, build: 26100, hypervisor: true, model: "QEMU Standard PC (Q35 + ICH9, 2009)" };
    expect(await windowsInstall({ home, run: install("Error code: Wsl/0x80370102\r\ndism exit 50 50\r\nfailed 1\r\n"), exe: null, tmpDir, checks: vm })).toMatchObject({ state: "blocked", why: "nested_vm" });
    expect(await readFile(installLogFile(home), "utf8")).toContain("0x80370102");
    expect(installLogFile(home)).toBe(join(home, "setup-win.log"));
    expect(await readdir(tmpDir)).toEqual([]);
    expect(await windowsInstall({ home, run: install("Error code: Wsl/0x80370102\r\nfailed 1\r\n"), exe: null, tmpDir, checks: { ...vm, model: "LENOVO 20XW" } })).toMatchObject({ state: "blocked", why: "firmware_off" });
    const failed = await windowsInstall({ home, run: install("Error: access denied\r\n"), exe: null, tmpDir, checks: vm });
    expect(failed).toMatchObject({ state: "failed" });
    expect(failed.message).toBe(`The WSL install did not finish: Error: access denied (log: ${installLogFile(home)})`);
    expect(await readFile(installLogFile(home), "utf8")).toContain("access denied");
  });

  test("a virtualization error from the probe: nested_vm in a VM guest, else firmware_off", () => {
    const vmError = fail("WSL 2 could not start: Wsl/Service/CreateInstance/CreateVm/HCS/HCS_E_HYPERV_NOT_INSTALLED");
    expect(blockedWhy({ model: "VMware, Inc. VMware7,1" })).toBe("nested_vm");
    expect(blockedWhy(null)).toBe("firmware_off");
    expect(classifySetup({ runtime: vmError, platform: "win32", checks: { ...checks, hypervisor: true, model: "QEMU Standard PC" }, fallback: "native" })).toMatchObject({ need: "cannot_run", why: "nested_vm" });
    expect(classifySetup({ runtime: vmError, platform: "win32", checks: { ...checks, hypervisor: true }, fallback: "native" })).toMatchObject({ need: "cannot_run", why: "firmware_off" });
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

  test("resume: a slow `wsl --update` is waited for a short while, then goes on in the background and finishes the setup (CLI: the same)", async () => {
    const home = await temp("home");
    saveSetupState(home, "win", { state: "restart" });
    let finish: () => void = () => {};
    let updated = false;
    const run: RunCommand = async (_bin, args) => {
      if (args[0] === "--update") { await new Promise<void>((resolve) => { finish = resolve; }); updated = true; return ok; }
      if (args[0] === "--status") return updated ? { code: 0, stdout: "Default Version: 2\n", stderr: "" } : { code: 1, stdout: "WSL 2 requires an update to its kernel component. Run 'wsl --update'.\n", stderr: "" };
      return ok;
    };
    let ready: unknown = null;
    const alive = setInterval(() => {}, 1_000);
    const started = Date.now();
    const res = await resumeWinSetup({ home, bin: "wsl.exe", run, bootedAt: Date.now() + 60_000, updateWaitMs: 50, onReady: (r) => { ready = r; } });
    expect(res).toEqual({ ok: false, state: "updating" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(setupState(home).win?.state).toBe("restart");
    finish();
    for (let i = 0; i < 50 && !ready; i += 1) await new Promise((r) => setTimeout(r, 10));
    clearInterval(alive);
    expect(ready).toEqual({ ok: true, state: "ready" });
    expect(setupState(home).win).toBeUndefined();
    expect(RESUME_UPDATE_WAIT_MS).toBe(120_000);
  });

  test("install script: every native call guarded (PowerShell 5.1 stops on a redirected stderr line under Stop); done only after it worked", () => {
    const script = REQUIRED_RULES.setup.win32.install_script;
    for (const line of script.filter((l) => /\b(?:wsl|dism)\.exe\b/.test(l))) expect(line).toMatch(/Invoke-Native '(?:wsl|dism)\.exe'/);
    expect(script.every((line) => !/2>&1/.test(line) || /try \{/.test(line))).toBe(true);
    expect(script.at(-1)).toBe("if ($code -eq 0) { Add-Log 'done' } else { Add-Log \"failed $code\" }");
  });
});
