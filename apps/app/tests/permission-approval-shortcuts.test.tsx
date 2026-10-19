/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { PendingPermission } from "../src/app/types";

if (typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined") {
  GlobalRegistrator.register({ url: "http://localhost/" });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const { PermissionApprovalPanel, permissionShortcutReply } = await import("../src/react-app/domains/session/chat/permission-approval-modal");

function pendingPermission(id = "permission-1"): PendingPermission {
  return {
    id,
    sessionID: "session-1",
    permission: "bash",
    patterns: ["git push origin main"],
    metadata: {},
    always: { session: false, project: false },
    receivedAt: 1,
    protocol: "legacy",
  };
}

const mounted: { root: Root; container: HTMLElement }[] = [];

async function mount(props: { busy?: boolean; id?: string } = {}) {
  const replies: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(
    <PermissionApprovalPanel
      permission={pendingPermission(props.id)}
      busy={props.busy}
      respondPermission={(id, reply) => replies.push(`${id}:${reply}`)}
    />,
  ));
  return { container, replies };
}

async function press(key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  document.body.innerHTML = "";
});

test("Y allows once, A allows for the chat, N and Escape deny", async () => {
  for (const [key, reply] of [["y", "once"], ["Y", "once"], ["a", "always"], ["n", "reject"], ["Escape", "reject"]] as const) {
    const { replies } = await mount({ id: `p-${key}` });
    await press(key);
    expect({ key, replies }).toEqual({ key, replies: [`p-${key}:${reply}`] });
    // One reply per request, even when the key is pressed again before the card goes away.
    await press(key);
    expect(replies).toHaveLength(1);
    for (const { root, container } of mounted.splice(0)) {
      await act(async () => root.unmount());
      container.remove();
    }
  }
});

test("shows the keys on the buttons", async () => {
  const { container } = await mount();
  const hints = [...container.querySelectorAll("kbd")].map((element) => element.textContent);
  expect(hints).toEqual(["N", "Y", "A"]);
  expect(container.querySelector('[data-permission-reply="once"]')?.getAttribute("aria-keyshortcuts")).toBe("Y");
  expect(container.querySelector('[data-permission-reply="reject"]')?.getAttribute("aria-keyshortcuts")).toBe("N Escape");
});

test("never takes keystrokes from the composer or other text fields", async () => {
  const { replies } = await mount();
  const textarea = document.createElement("textarea");
  const input = document.createElement("input");
  const select = document.createElement("select");
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  const inner = document.createElement("span");
  editor.append(inner);
  document.body.append(textarea, input, select, editor);
  for (const field of [textarea, input, select, editor, inner]) {
    await press("y", field);
    await press("Escape", field);
  }
  textarea.focus();
  await press("a");
  expect(replies).toEqual([]);
  // Focus elsewhere: the card answers again.
  textarea.blur();
  await press("y");
  expect(replies).toEqual(["permission-1:once"]);
});

test("ignores modifier chords, other keys, other dialogs and a busy card", async () => {
  const { replies } = await mount();
  await press("y", document.body, { metaKey: true });
  await press("a", document.body, { ctrlKey: true });
  await press("n", document.body, { altKey: true });
  await press("x");
  await press("Enter");
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const button = document.createElement("button");
  dialog.append(button);
  document.body.append(dialog);
  await press("y", button);
  expect(replies).toEqual([]);

  const busy = await mount({ busy: true, id: "busy" });
  await press("y");
  expect(busy.replies).toEqual([]);
});

test("permissionShortcutReply reads the key, not the layout of the page", () => {
  const body = document.body;
  expect(permissionShortcutReply({ key: "y", target: body }, body)).toBe("once");
  expect(permissionShortcutReply({ key: "a", target: body }, body)).toBe("always");
  expect(permissionShortcutReply({ key: "N", target: body }, body)).toBe("reject");
  expect(permissionShortcutReply({ key: "Escape", target: body }, body)).toBe("reject");
  expect(permissionShortcutReply({ key: "y", target: body, repeat: true }, body)).toBeNull();
  expect(permissionShortcutReply({ key: "y", target: body, isComposing: true }, body)).toBeNull();
  expect(permissionShortcutReply({ key: "y", target: body, defaultPrevented: true }, body)).toBeNull();
  expect(permissionShortcutReply({ key: "y", target: body, shiftKey: true } as never, body)).toBe("once");
});
