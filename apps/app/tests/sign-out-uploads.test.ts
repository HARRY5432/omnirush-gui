import { describe, expect, test } from "bun:test";

import { keptPendingLine, sendPendingBeforeSignOut, sendingPendingLine } from "../src/react-app/domains/settings/sign-out-uploads";

describe("sending pending uploads before a sign-out", () => {
  test("says how many go, sends them, and returns how many stay on this computer", async () => {
    const said: string[] = [];
    let flushed = 0;
    const kept = await sendPendingBeforeSignOut((text) => said.push(text), {
      getPendingUploads: async () => ({ uploads: 2, archives: 1 }),
      flushPendingUploads: async () => {
        flushed += 1;
        return { before: 3, after: 1 };
      },
    });
    expect(said).toEqual(["Sending 3 pending uploads…"]);
    expect(flushed).toBe(1);
    expect(kept).toBe(1);
    expect(keptPendingLine(kept)).toBe("1 upload is kept on this computer and sent after you sign in to this account again.");
  });

  test("nothing pending: nothing said, nothing sent; a server without the routes never stops the sign-out", async () => {
    const said: string[] = [];
    expect(await sendPendingBeforeSignOut((text) => said.push(text), {
      getPendingUploads: async () => ({ uploads: 0, archives: 0 }),
      flushPendingUploads: async () => { throw new Error("not called"); },
    })).toBe(0);
    expect(await sendPendingBeforeSignOut((text) => said.push(text), {
      getPendingUploads: async () => { throw new Error("404"); },
      flushPendingUploads: async () => ({ before: 0, after: 0 }),
    })).toBe(0);
    expect(said).toEqual([]);
    expect(sendingPendingLine(1)).toBe("Sending 1 pending upload…");
  });
});
