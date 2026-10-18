import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveOmniRushSentryAppVersion,
  resolveOmniRushSentryRelease,
  scrubSentryEvent,
  scrubSentryPayload,
  scrubSentryText,
  setOmniRushSentryConsent,
} from "./sentry.mjs";

test("unpackaged Sentry release uses the desktop package version", () => {
  const appVersion = resolveOmniRushSentryAppVersion({
    app: { isPackaged: false, getVersion: () => "43.2.0" },
    packageMetadata: { version: "0.18.7" },
  });

  assert.equal(appVersion, "0.18.7");
  assert.equal(
    resolveOmniRushSentryRelease({ appVersion, environmentRelease: "" }),
    "omnirush-desktop@0.18.7",
  );
});

test("packaged Sentry release uses Electron's stamped app version", () => {
  const appVersion = resolveOmniRushSentryAppVersion({
    app: { isPackaged: true, getVersion: () => "0.18.8" },
    packageMetadata: { version: "0.18.7" },
  });

  assert.equal(appVersion, "0.18.8");
  assert.equal(
    resolveOmniRushSentryRelease({ appVersion, environmentRelease: "" }),
    "omnirush-desktop@0.18.8",
  );
});

test("Sentry release still honors an explicit build override", () => {
  assert.equal(
    resolveOmniRushSentryRelease({
      appVersion: "0.18.8",
      environmentRelease: "desktop-main@abcdef",
    }),
    "desktop-main@abcdef",
  );
});

test("report text loses tokens, credentials, e-mail addresses and home paths", () => {
  const scrubbed = scrubSentryText([
    "Authorization: Bearer abcdefghijklmnop",
    "fetch https://user:pass@den.example.com/v1?grant=g-123&page=2",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl",
    "keys sk-ant-oat01-abcdefghijkl ghp_abcdefghijklmnopqrstuv npm_abcdefghijklmnopqrstuv",
    "mail someone@example.com",
    "at /home/alice/project/src/index.ts and C:\\Users\\Bob\\Desktop\\x.txt and file:///Users/carol/w",
  ].join("\n"), "/home/alice");
  for (const secret of ["abcdefghijklmnop", "user:pass", "g-123", "eyJhbGci", "sk-ant-oat01", "ghp_", "npm_abcdef", "someone@example.com", "alice", "Bob", "carol"]) {
    assert.ok(!scrubbed.includes(secret), `${secret} leaked: ${scrubbed}`);
  }
  assert.match(scrubbed, /page=2/, "harmless query parameters stay");
  assert.match(scrubbed, /~\/project\/src\/index\.ts/);
});

test("events drop credential fields, cookies, request bodies and user contact data", () => {
  const event = scrubSentryEvent({
    request: { url: "https://den.example.com/x?token=t", headers: { Authorization: "Bearer x", Accept: "json" }, cookies: "a=b", data: "{\"password\":\"p\"}" },
    user: { id: "user_1", email: "u@example.com", ip_address: "1.2.3.4" },
    extra: { ownerToken: "secret", nested: { apiKey: "k", note: "ok" } },
    breadcrumbs: [{ message: "GET /home/alice/x?code=abc" }],
  });
  assert.deepEqual(event.request, { url: "https://den.example.com/x?token=[Filtered]", headers: { Authorization: "[Filtered]", Accept: "json" } });
  assert.deepEqual(event.user, { id: "user_1" });
  assert.deepEqual(event.extra, { ownerToken: "[Filtered]", nested: { apiKey: "[Filtered]", note: "ok" } });
  assert.equal(scrubSentryPayload({ category: "console", message: "token at /home/alice/x" }, "/home/alice").message, "token at ~/x");
});

test("the usage-sharing setting alone never turns reporting on without a session", () => {
  assert.equal(setOmniRushSentryConsent(true), false);
  assert.equal(setOmniRushSentryConsent(false), false);
});
