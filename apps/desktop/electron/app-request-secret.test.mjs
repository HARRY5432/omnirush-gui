import assert from "node:assert/strict";
import { test } from "node:test";

import { APP_SECRET_HEADER, appSecretHeaders, installAppRequestSecret, rememberLocalServer } from "./app-request-secret.mjs";

const SECRET = globalThis[Symbol.for("omnirush.app.request-secret")];

test("the secret exists once per launch, in this process only", () => {
  assert.equal(typeof SECRET, "string");
  assert.ok(SECRET.length >= 64);
  assert.equal(process.env[APP_SECRET_HEADER], undefined);
  assert.ok(!Object.values(process.env).includes(SECRET));
});

test("Electron main's own requests carry it to the local server only", () => {
  rememberLocalServer("http://127.0.0.1:43123");
  assert.deepEqual(appSecretHeaders("http://127.0.0.1:43123/tokens"), { [APP_SECRET_HEADER]: SECRET });
  assert.deepEqual(appSecretHeaders("http://127.0.0.1:43124/tokens"), {});
  assert.deepEqual(appSecretHeaders("https://omnirush.ai/tokens"), {});
  rememberLocalServer("https://example.com");
  assert.deepEqual(appSecretHeaders("https://example.com/x"), {});
});

test("the app window's requests to the local server get it; other pages, ports and copies a page set do not", () => {
  rememberLocalServer("http://127.0.0.1:43123");
  let listener = null;
  const session = { webRequest: { onBeforeSendHeaders: (filter, fn) => { assert.ok(filter.urls.includes("http://127.0.0.1/*")); listener = fn; } } };
  installAppRequestSecret(session, (id) => id === 7);
  const run = (details) => { let out = null; listener(details, (result) => { out = result.requestHeaders; }); return out; };
  assert.equal(run({ webContentsId: 7, url: "http://127.0.0.1:43123/runtime-config/approvals", requestHeaders: { Authorization: "Bearer x" } })[APP_SECRET_HEADER], SECRET);
  assert.equal(run({ webContentsId: 8, url: "http://127.0.0.1:43123/runtime-config/approvals", requestHeaders: {} })[APP_SECRET_HEADER], undefined);
  assert.equal(run({ webContentsId: 7, url: "http://127.0.0.1:5173/", requestHeaders: {} })[APP_SECRET_HEADER], undefined);
  assert.equal(run({ webContentsId: undefined, url: "http://127.0.0.1:43123/tokens", requestHeaders: {} })[APP_SECRET_HEADER], undefined);
  const forged = run({ webContentsId: 9, url: "http://127.0.0.1:43123/tokens", requestHeaders: { "X-OmniRush-App-Secret": "forged" } });
  assert.ok(!Object.keys(forged).some((name) => name.toLowerCase() === APP_SECRET_HEADER));
});
