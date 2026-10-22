import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { desktopText, hostOnlyProject, parseWindowsFacts, requiredFallback, virtualizationError, whyText, windowsInstallScript, windowsWhy } from "./required.js";

const facts = { build: 22631, hypervisorPresent: false, firmwareEnabled: true, model: "Dell Inc. XPS 13", sMode: false };

describe("required sandbox rules", () => {
  test("fallback and texts", () => {
    expect(requiredFallback("native_uncounted")).toBe("native_uncounted");
    expect(requiredFallback("block")).toBe("native");
    expect(requiredFallback(undefined)).toBe("native");
    expect(desktopText("opt_out_refused")).toContain("Required for new chats");
    expect(desktopText("cannot_run", { why: "x" })).toBe("The sandbox can't run on this computer: x.");
    expect(whyText("firmware_off")).toContain("BIOS/UEFI");
    expect(whyText("nope")).toBeNull();
  });

  test("windows: a running hypervisor passes, firmware off, nested VM, S mode, old build, policy", () => {
    expect(windowsWhy(facts)).toBeNull();
    expect(windowsWhy({ ...facts, hypervisorPresent: true, firmwareEnabled: false })).toBeNull();
    expect(windowsWhy({ ...facts, firmwareEnabled: false })).toBe("firmware_off");
    expect(windowsWhy({ ...facts, firmwareEnabled: false, model: "Microsoft Corporation Virtual Machine" })).toBe("nested_vm");
    expect(windowsWhy({ ...facts, model: "innotek GmbH VirtualBox", wslSaid: "Error code: Wsl/Service/CreateInstance/0x80370102" })).toBe("nested_vm");
    expect(windowsWhy({ ...facts, sMode: true })).toBe("s_mode");
    expect(windowsWhy({ ...facts, build: 18363 })).toBe("old_windows");
    expect(windowsWhy({ ...facts, policy: true })).toBe("policy");
    expect(windowsWhy({ build: null, hypervisorPresent: null, firmwareEnabled: null, model: null, sMode: null })).toBeNull();
    expect(virtualizationError("Please enable the Virtual Machine Platform Windows feature")).toBe(true);
    expect(virtualizationError("The operation completed successfully.")).toBe(false);
  });

  test("windows facts parse from the PowerShell JSON line", () => {
    expect(parseWindowsFacts('{"build":19045,"hypervisor":false,"firmware":true,"model":" LENOVO 20XW ","smode":false}\r\n')).toEqual({ build: 19045, hypervisorPresent: false, firmwareEnabled: true, model: "LENOVO 20XW", sMode: false });
    expect(parseWindowsFacts("garbage")).toEqual({ build: null, hypervisorPresent: null, firmwareEnabled: null, model: null, sMode: null });
  });

  test("the install script is the shared one, CRLF, with its log argument", () => {
    const script = windowsInstallScript();
    expect(script).toContain("wsl.exe --install --no-distribution");
    expect(script).toContain("$log = $args[0]");
    expect(script.endsWith("\r\n")).toBe(true);
  });

  test("host-only projects: Xcode on macOS, WPF and vcxproj on Windows, never Linux", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hostonly-"));
    mkdirSync(path.join(root, "App.xcodeproj"));
    expect(hostOnlyProject(root, { platform: "darwin" })?.things).toEqual(["App.xcodeproj"]);
    expect(hostOnlyProject(root, { platform: "linux" })).toBeNull();
    const win = mkdtempSync(path.join(os.tmpdir(), "hostonly-"));
    mkdirSync(path.join(win, "src"));
    writeFileSync(path.join(win, "src", "Desk.csproj"), "<Project><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>");
    writeFileSync(path.join(win, "Lib.csproj"), "<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>");
    const found = hostOnlyProject(win, { platform: "win32" });
    expect(found?.things).toEqual(["Desk.csproj"]);
    expect(found?.notice).toContain("only builds on Windows (Desk.csproj)");
    const swift = mkdtempSync(path.join(os.tmpdir(), "hostonly-"));
    writeFileSync(path.join(swift, "Package.swift"), "let package = Package(name: \"x\", platforms: [.iOS(.v17)])");
    expect(hostOnlyProject(swift, { platform: "darwin" })?.things).toEqual(["Package.swift"]);
    writeFileSync(path.join(swift, "Package.swift"), "let package = Package(name: \"x\")");
    expect(hostOnlyProject(swift, { platform: "darwin" })).toBeNull();
  });
});
