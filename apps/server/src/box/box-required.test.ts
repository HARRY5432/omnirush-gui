import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { desktopText, hostOnlyProject, requiredFallback, requiredLaunch, whyText } from "./required.js";

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
    expect(found?.things).toEqual(["src/Desk.csproj"]);
    expect(found?.notice).toContain("only builds on Windows (src/Desk.csproj)");
    const swift = mkdtempSync(path.join(os.tmpdir(), "hostonly-"));
    writeFileSync(path.join(swift, "Package.swift"), "let package = Package(name: \"x\", platforms: [.iOS(.v17)])");
    expect(hostOnlyProject(swift, { platform: "darwin" })?.things).toEqual(["Package.swift"]);
    writeFileSync(path.join(swift, "Package.swift"), "let package = Package(name: \"x\")");
    expect(hostOnlyProject(swift, { platform: "darwin" })).toBeNull();
  });

  test("launch record: a machine that can't run the box says so (fallback native, counted); turned off or declined gets the server's fallback (CLI: the same)", () => {
    expect(requiredLaunch("box", { native: false })).toEqual({ required: true, capable: true });
    for (const reason of ["cannot_run", "box_failed", "setup_needed", "planning", "downloading"]) expect(requiredLaunch(reason, { native: true, serverFallback: "native_uncounted" })).toEqual({ required: true, capable: false, fallback: "native" });
    for (const reason of ["env_off", "setup_declined"]) expect(requiredLaunch(reason, { native: true, serverFallback: "native_uncounted" })).toEqual({ required: true, capable: true, fallback: "native_uncounted" });
    expect(requiredLaunch("env_off", { native: true, serverFallback: "bogus" }).fallback).toBe("native");
    for (const reason of ["kept_old_chat", "host_only"]) expect(requiredLaunch(reason, { native: true, serverFallback: "native_uncounted" })).toEqual({ required: true, fallback: "native" });
  });
});
