import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const sessionPagePath = fileURLToPath(
  new URL("../src/react-app/domains/session/chat/session-page.tsx", import.meta.url),
);

test("hidden Cloud sign-in does not reserve header space", () => {
  const source = readFileSync(sessionPagePath, "utf8");

  expect(source).toContain("{showCloudSignIn ? (");
  expect(source).not.toContain('className={showCloudSignIn ? undefined : "invisible"}');
  expect(source).not.toContain("disabled={!showCloudSignIn}");
});

test("header title side truncates and never runs under the buttons", () => {
  const source = readFileSync(sessionPagePath, "utf8");
  const header = source.slice(source.indexOf("<header className="), source.indexOf("</header>"));
  // Title side takes the leftover room and may shrink to nothing; the buttons side keeps its size.
  expect(header).toMatch(/className="flex min-w-0 flex-1 items-center gap-3" data-session-header-title/);
  expect(header).toMatch(/className="flex min-w-0 shrink-0 items-center justify-end gap-1.5[^"]*" data-session-header-actions/);
  expect(header).toContain('"min-w-0 truncate text-[13px] font-medium text-dls-text"');
  const ideChrome = readFileSync(fileURLToPath(new URL("../src/react-app/domains/session/editor/ide-chrome.tsx", import.meta.url)), "utf8");
  // Button defaults to shrink-0; the chat switcher must be allowed to shrink so its title truncates.
  expect(ideChrome).toMatch(/className="h-7 min-w-0 max-w-64 shrink [^"]*" data-chat-switcher/);
});

test("the More actions menu offers My Buildathon after the chip is gone", () => {
  const source = readFileSync(sessionPagePath, "utf8");
  expect(source).toContain("const buildathonMenu = useBuildathonMenuItem();");
  expect(source).toMatch(/\{buildathonMenu\.visible \? \(\s*<DropdownMenuItem onClick=\{buildathonMenu\.open\} data-menu-buildathon>/);
  // The "…" button stays visible in a wide Chat layout while the item is offered.
  expect(source).toContain('!ideMode && !buildathonMenu.visible && "@min-[40rem]/titlebar:hidden"');
});
