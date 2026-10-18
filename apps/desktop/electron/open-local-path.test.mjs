import assert from "node:assert/strict";
import test from "node:test";

import { classifyLocalOpen, isExecutablePath, isNetworkPath, localPathFromFileUrl } from "./open-local-path.mjs";

const regularFile = () => ({ isFile: () => true, mode: 0o644 });
const executableFile = () => ({ isFile: () => true, mode: 0o755 });

test("network paths are never touched", () => {
  for (const target of ["\\\\host\\share\\x.exe", "//host/share/x.exe", "\\/host/x", "\\\\?\\C:\\x.txt", "\\\\.\\pipe\\x"]) {
    assert.equal(isNetworkPath(target), true, target);
    assert.equal(classifyLocalOpen(target, { platform: "win32" }), "deny", target);
  }
  assert.equal(classifyLocalOpen("//host/share/notes.md", { platform: "linux", stat: regularFile }), "deny");
});

test("file URLs naming a host are refused, local ones map to paths", () => {
  assert.equal(localPathFromFileUrl("file://host/share/x.exe", "win32"), null);
  assert.equal(localPathFromFileUrl("file:////host/share/x.exe", "win32"), null);
  assert.equal(localPathFromFileUrl("file://attacker.example/x", "linux"), null);
  assert.equal(localPathFromFileUrl("https://example.com/x", "linux"), null);
  assert.equal(localPathFromFileUrl("file:///home/user/w/notes.md", "linux"), "/home/user/w/notes.md");
  assert.equal(localPathFromFileUrl("file://localhost/home/user/w/notes.md", "linux"), "/home/user/w/notes.md");
  assert.equal(localPathFromFileUrl("file:///C:/Users/me/w/notes.md", "win32"), "C:\\Users\\me\\w\\notes.md");
});

test("programs and scripts are revealed in their folder instead of opened on Windows", () => {
  for (const target of ["C:\\w\\setup.exe", "C:\\w\\run.BAT", "C:\\w\\tool.ps1", "C:\\w\\script.js", "C:\\w\\job.py", "C:\\w\\link.lnk", "C:\\w\\x.exe.", "C:\\w\\x.exe  ", "C:\\w\\x.msi", "C:\\w\\x.hta", "C:\\w\\x.url"]) {
    assert.equal(classifyLocalOpen(target, { platform: "win32" }), "reveal", target);
  }
  assert.equal(classifyLocalOpen("C:\\w\\report.pdf", { platform: "win32" }), "open");
  assert.equal(classifyLocalOpen("C:\\w\\notes.txt:payload.exe", { platform: "win32" }), "deny", "alternate data stream");
  assert.equal(classifyLocalOpen("relative\\notes.md", { platform: "win32" }), "deny");
});

test("macOS bundles and Linux executables are revealed, documents open", () => {
  assert.equal(classifyLocalOpen("/Users/me/w/Tool.app", { platform: "darwin", stat: regularFile }), "reveal");
  assert.equal(classifyLocalOpen("/Users/me/w/run.command", { platform: "darwin", stat: regularFile }), "reveal");
  assert.equal(classifyLocalOpen("/home/me/w/build.sh", { platform: "linux", stat: executableFile }), "reveal");
  assert.equal(classifyLocalOpen("/home/me/w/app.desktop", { platform: "linux", stat: regularFile }), "reveal");
  assert.equal(classifyLocalOpen("/home/me/w/script.py", { platform: "linux", stat: regularFile }), "open", "non-executable source opens in its editor");
  assert.equal(isExecutablePath("/missing/file.txt", { platform: "linux", stat: () => { throw new Error("ENOENT"); } }), false);
});

test("transcript links open only files inside a workspace", () => {
  /** @type {{ platform: NodeJS.Platform, workspaceRoots: string[] }} */
  const options = { platform: "win32", workspaceRoots: ["C:\\Users\\me\\Project"] };
  assert.equal(classifyLocalOpen("C:\\Users\\me\\Project\\docs\\notes.md", options), "open");
  assert.equal(classifyLocalOpen("c:\\users\\ME\\project\\notes.md", options), "open", "Windows paths compare case-insensitively");
  assert.equal(classifyLocalOpen("C:\\Users\\me\\Project-other\\notes.md", options), "reveal");
  assert.equal(classifyLocalOpen("C:\\Users\\me\\Project\\..\\secrets.txt", options), "reveal");
  assert.equal(classifyLocalOpen("C:\\Windows\\win.ini", options), "reveal");
  assert.equal(classifyLocalOpen("/home/me/w/a.md", { platform: "linux", stat: regularFile, workspaceRoots: ["//host/share"] }), "reveal", "network roots never count");
});
