import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { draftToParts } from "../src/react-app/domains/session/sync/draft-parts";
import {
  firstLineLocalFileParts,
  isWindowsWorkspaceRoot,
  promptFileUrl,
  toFileUrl,
} from "../src/react-app/domains/session/sync/prompt-file-parts";

// The engine turns every `file://` part back into a path with fileURLToPath;
// on Windows it throws "File URL path must be an absolute path" for anything
// without a drive or UNC host, which failed the whole message.
function windowsPath(url: string) {
  return fileURLToPath(url, { windows: true });
}

function posixPath(url: string) {
  return fileURLToPath(url, { windows: false });
}

function fileUrls(parts: Array<{ type: string; url?: string }>) {
  return parts.filter((part) => part.type === "file").map((part) => part.url ?? "");
}

describe("Windows workspace roots", () => {
  test("detects drive and UNC roots", () => {
    expect(isWindowsWorkspaceRoot("C:\\Users\\omar\\code")).toBe(true);
    expect(isWindowsWorkspaceRoot("d:/work")).toBe(true);
    expect(isWindowsWorkspaceRoot("\\\\server\\share\\proj")).toBe(true);
    expect(isWindowsWorkspaceRoot("//server/share/proj")).toBe(true);
    expect(isWindowsWorkspaceRoot("/home/omar/code")).toBe(false);
    expect(isWindowsWorkspaceRoot("/Users/omar/code")).toBe(false);
  });
});

describe("prompt file URLs", () => {
  test("drops POSIX-style paths in a Windows workspace", () => {
    expect(promptFileUrl("/api/users.json", "C:\\Users\\omar\\code")).toBe("");
    expect(promptFileUrl("/src/index.ts", "C:/Users/omar/code")).toBe("");
  });

  test("drops relative paths everywhere", () => {
    expect(promptFileUrl("src/index.ts", "C:\\Users\\omar\\code")).toBe("");
    expect(promptFileUrl("src/index.ts", "/home/omar/code")).toBe("");
  });

  test("keeps drive and UNC paths the engine can open on Windows", () => {
    const drive = promptFileUrl("C:\\Users\\omar\\my code\\a#1.ts", "C:\\Users\\omar\\code");
    expect(windowsPath(drive)).toBe("C:\\Users\\omar\\my code\\a#1.ts");
    const unc = promptFileUrl("\\\\server\\share\\proj\\notes.md", "\\\\server\\share\\proj");
    expect(unc).toBe("file://server/share/proj/notes.md");
    expect(windowsPath(unc)).toBe("\\\\server\\share\\proj\\notes.md");
  });

  test("keeps POSIX paths in a POSIX workspace", () => {
    expect(promptFileUrl("/home/omar/code/a.ts", "/home/omar/code")).toBe("file:///home/omar/code/a.ts");
  });

  test("UNC paths get the server as the URL host on Windows only", () => {
    expect(toFileUrl("//server/share/x.ts", true)).toBe("file://server/share/x.ts");
    expect(toFileUrl("//server/share/x.ts")).toBe("file:////server/share/x.ts");
  });

  test("double-slash paths on macOS and Linux stay valid POSIX URLs", () => {
    const url = promptFileUrl("//server/share/x.ts", "/home/omar/code");
    expect(posixPath(url)).toBe("//server/share/x.ts");
    expect(posixPath(toFileUrl("//net/a.ts"))).toBe("//net/a.ts");
  });

  test("Windows device paths and odd hosts are not sent", () => {
    const root = "C:\\Users\\omar\\code";
    expect(promptFileUrl("\\\\?\\C:\\x\\a.ts", root)).toBe("");
    expect(promptFileUrl("\\\\.\\pipe\\x", root)).toBe("");
    expect(promptFileUrl("\\\\my host\\share\\a.ts", root)).toBe("");
    expect(toFileUrl("//?/C:/x", true)).not.toStartWith("file://?");
  });
});

describe("Windows first-line paths", () => {
  test("a URL-style path in the first line is not sent as a file", () => {
    const parts = firstLineLocalFileParts("fix the /api/login route and /src/app.ts", "C:\\Users\\omar\\code");
    expect(parts).toEqual([]);
  });

  test("every file part from a Windows first line is a valid Windows path", () => {
    const parts = firstLineLocalFileParts(
      "compare C:\\Users\\omar\\a.ts with /etc/hosts and file:///C:/Users/omar/b.ts",
      "C:\\Users\\omar\\code",
    );
    const urls = fileUrls(parts);
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(() => windowsPath(url)).not.toThrow();
  });
});

describe("POSIX first-line paths", () => {
  test("a file URL with a host never becomes a URL the engine rejects", () => {
    const parts = firstLineLocalFileParts("open file://server/share/a.ts and /home/omar/b.ts", "/home/omar/code");
    for (const url of fileUrls(parts)) expect(() => posixPath(url)).not.toThrow();
  });
});

describe("Windows draft mentions", () => {
  test("mentions resolve inside the workspace and never make an unreadable URL", async () => {
    const parts = await draftToParts(
      {
        mode: "prompt",
        text: "look at @src/app.ts and @/docs/readme.md, also /api/users.json",
        parts: [
          { type: "file", path: "src/app.ts" },
          { type: "file", path: "/docs/readme.md" },
        ],
        attachments: [],
      },
      "C:\\Users\\omar\\code",
      "ses_test",
      null,
    );
    const urls = fileUrls(parts);
    expect(urls.map(windowsPath)).toEqual([
      "C:\\Users\\omar\\code\\src\\app.ts",
      "C:\\Users\\omar\\code\\docs\\readme.md",
    ]);
  });

  test("POSIX workspaces keep absolute mentions", async () => {
    const parts = await draftToParts(
      {
        mode: "prompt",
        text: "look at @/etc/hosts",
        parts: [{ type: "file", path: "/etc/hosts" }],
        attachments: [],
      },
      "/home/omar/code",
      "ses_test",
      null,
    );
    expect(fileUrls(parts)).toEqual(["file:///etc/hosts"]);
  });

  test("POSIX double-slash mentions stay valid POSIX URLs", async () => {
    const parts = await draftToParts(
      {
        mode: "prompt",
        text: "look at @//srv/share/a.ts",
        parts: [{ type: "file", path: "//srv/share/a.ts" }],
        attachments: [],
      },
      "/home/omar/code",
      "ses_test",
      null,
    );
    for (const url of fileUrls(parts)) expect(() => posixPath(url)).not.toThrow();
  });
});
