import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ALLOWANCE_GUIDE_GOOD_SESSION_URL,
  ALLOWANCE_GUIDE_URL,
  ALLOWANCE_SECTIONS,
  GOOD_SESSION_SECTIONS,
  utcMidnightLocal,
} from "../src/app/lib/allowance-help";
import { FLOOR_ALONE_FILES, FLOOR_ALONE_LINES, FLOOR_FILES, FLOOR_LINES, GOOD_SESSION_GUIDE } from "../src/app/lib/good-session";
import { AllowanceHelpBody, openAllowanceHelp, useAllowanceHelpStore } from "../src/react-app/domains/quality/allowance-help";

const allText = (sections: typeof ALLOWANCE_SECTIONS) =>
  sections.flatMap((section) => [section.title, section.text ?? "", ...(section.points ?? [])]).join("\n");

describe("allowance help content", () => {
  test("midnight UTC on the user's clock", () => {
    const now = Date.UTC(2026, 9, 21, 12, 0);
    expect(utcMidnightLocal({ timeZone: "Asia/Kolkata", now })).toBe("5:30 AM");
    expect(utcMidnightLocal({ timeZone: "America/New_York", now })).toBe("8:00 PM");
    expect(utcMidnightLocal({ timeZone: "UTC", now })).toBe("12:00 AM");
  });

  test("states the fixed rules: UTC reset, Monday week, cached input share", () => {
    const text = allText(ALLOWANCE_SECTIONS);
    expect(text).toContain("00:00 UTC every day");
    expect(text).toContain("Monday at 00:00 UTC");
    expect(text).toContain("Cached input");
    expect(text).toContain("a fraction of its size (currently a quarter)");
    expect(text).toContain("Reasoning tokens");
  });

  test("hardcodes no admin-set token amounts", () => {
    const text = allText(ALLOWANCE_SECTIONS) + allText(GOOD_SESSION_SECTIONS);
    expect(text).not.toMatch(/\d+(\.\d+)?\s?[MK]\b/);
    expect(text).not.toMatch(/\d+\s?%/);
    expect(text).not.toMatch(/[x×]\s?\d/);
  });

  test("the Good-session part matches the live checklist", () => {
    const text = allText(GOOD_SESSION_SECTIONS);
    expect(text).toContain(`at least ${FLOOR_FILES} code files and ${FLOOR_LINES} lines, or ${FLOOR_ALONE_FILES} files and ${FLOOR_ALONE_LINES} lines`);
    // Every step of the short guide is covered.
    expect(GOOD_SESSION_GUIDE.length).toBe(4);
    for (const label of ["In a project", "Code changed", "Ran or tested", "Finished"]) expect(text).toContain(label);
  });

  test("links to the site guide", () => {
    expect(ALLOWANCE_GUIDE_URL).toBe("https://omnirush.ai/guide");
    expect(ALLOWANCE_GUIDE_GOOD_SESSION_URL).toBe("https://omnirush.ai/guide#good-session");
  });
});

describe("allowance help dialog", () => {
  test("the store opens a tab and closes", () => {
    openAllowanceHelp();
    expect(useAllowanceHelpStore.getState().tab).toBe("allowance");
    openAllowanceHelp("good-session");
    expect(useAllowanceHelpStore.getState().tab).toBe("good-session");
    useAllowanceHelpStore.getState().close();
    expect(useAllowanceHelpStore.getState().tab).toBeNull();
  });

  test("the tokens tab shows the account line and the local reset", () => {
    const html = renderToStaticMarkup(
      <AllowanceHelpBody tab="allowance" usageLine="3.2M of 10M tokens left today" resetLocal="5:30 AM" />,
    );
    expect(html).toContain("3.2M of 10M tokens left today");
    expect(html).toContain("Daily tokens refill at 00:00 UTC, which is 5:30 AM on your clock.");
    for (const section of ALLOWANCE_SECTIONS) expect(html).toContain(section.title);
  });

  test("the Good-session tab lists the checklist", () => {
    const html = renderToStaticMarkup(<AllowanceHelpBody tab="good-session" resetLocal="5:30 AM" />);
    for (const section of GOOD_SESSION_SECTIONS) expect(html).toContain(section.title);
  });
});
