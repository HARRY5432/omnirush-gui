import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PROJECT_CODE_NOTICE_STORAGE_KEY,
  PROJECT_CODE_NOTICE_TEXT,
  markProjectCodeNoticeShown,
  projectCodeNoticeDetails,
  projectCodeNoticeShown,
  takeProjectCodeNotice,
} from "../src/app/lib/project-code-notice";
import { ProjectCodeNoticeCard } from "../src/react-app/domains/session/surface/project-code-notice";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const ignored = [
  { kind: "plugin" as const, name: "opencode-chrome-devtools@1.0.4", source: "/repo/opencode.json" },
  { kind: "plugin" as const, name: "file:///repo/.opencode/plugin/evil.ts", source: null },
  { kind: "lsp" as const, name: "custom-ls", source: null },
  { kind: "provider" as const, name: "provider", source: "/repo/opencode.json" },
  { kind: "provider" as const, name: "anthropic", source: "/repo/opencode.json" },
];

describe("project config notice", () => {
  test("one short line; details name each skipped item", () => {
    expect(PROJECT_CODE_NOTICE_TEXT).toBe("Project plugins and provider settings are off for safety. Your own settings still apply.");
    expect(projectCodeNoticeDetails(ignored)).toEqual([
      "Plugin: opencode-chrome-devtools@1.0.4",
      "Plugin: evil.ts",
      "Language server: custom-ls",
      "Model provider settings",
    ]);
    expect(projectCodeNoticeDetails([])).toEqual([]);
    expect(projectCodeNoticeDetails(null)).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: "plugin" as const, name: `p${i}`, source: null }));
    expect(projectCodeNoticeDetails(many)).toHaveLength(13);
    expect(projectCodeNoticeDetails(many).at(-1)).toBe("and 8 more");
  });

  test("at most once per project folder, remembered across runs", () => {
    const storage = memoryStorage();
    const first = takeProjectCodeNotice("/home/me/proj-a/", { ignored }, storage);
    expect(first).toMatchObject({ text: PROJECT_CODE_NOTICE_TEXT, id: "project-code-ignored:/home/me/proj-a" });
    expect(first?.details).toContain("Model provider settings");
    expect(takeProjectCodeNotice("/home/me/proj-a", { ignored }, storage)).toBeNull();
    expect(projectCodeNoticeShown("/home/me/proj-a", storage)).toBe(true);
    expect(JSON.parse(storage.data.get(PROJECT_CODE_NOTICE_STORAGE_KEY)!)).toEqual(["/home/me/proj-a"]);
    // Another folder gets its own notice.
    expect(takeProjectCodeNotice("/home/me/proj-b", { ignored }, storage)).not.toBeNull();
    // A later app run (fresh in-memory state) still reads the stored list.
    const later = memoryStorage();
    markProjectCodeNoticeShown("/home/me/proj-c", later);
    expect(takeProjectCodeNotice("/home/me/proj-c", { ignored }, later)).toBeNull();
  });

  test("nothing skipped, no notice; an older server's sentence becomes the details", () => {
    const storage = memoryStorage();
    expect(takeProjectCodeNotice("/p/none", { ignored: [] }, storage)).toBeNull();
    expect(takeProjectCodeNotice("/p/none", null, storage)).toBeNull();
    expect(projectCodeNoticeShown("/p/none", storage)).toBe(false);
    const old = takeProjectCodeNotice("/p/old", { ignoredNotice: "Not loaded from this project's config: plugins x.ts." }, storage);
    expect(old?.details).toEqual(["Not loaded from this project's config: plugins x.ts."]);
  });

  test("the card: short line with Details and a close button; details list when open", () => {
    const closed = renderToStaticMarkup(<ProjectCodeNoticeCard text={PROJECT_CODE_NOTICE_TEXT} details={["Plugin: a"]} onDismiss={() => undefined} />);
    expect(closed).toContain(PROJECT_CODE_NOTICE_TEXT);
    expect(closed).toContain(">Details<");
    expect(closed).toContain('aria-label="Dismiss"');
    expect(closed).not.toContain("Plugin: a");
    const open = renderToStaticMarkup(<ProjectCodeNoticeCard text={PROJECT_CODE_NOTICE_TEXT} details={["Plugin: a"]} onDismiss={() => undefined} defaultOpen />);
    expect(open).toContain("Plugin: a");
    expect(open).toContain("Hide details");
  });
});
