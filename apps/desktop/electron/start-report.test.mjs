import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  antivirusHint,
  buildStartFailureReport,
  classifyStartFailure,
  cpuHasAvx2,
  createStartReporter,
  inspectEngineBinary,
  osBuild,
  profileFlags,
  reportVersion,
  scrubStartMessage,
  startFailureHint,
} from "./start-report.mjs";

function spawnError(code, errno = -2) {
  return Object.assign(new Error(`spawn C:\\Users\\Ana\\AppData\\Local\\Programs\\omnirush.ai\\resources\\sidecars\\opencode.exe ${code}`), {
    code,
    errno,
    syscall: "spawn C:\\Users\\Ana\\AppData\\Local\\Programs\\omnirush.ai\\resources\\sidecars\\opencode.exe",
    path: "C:\\Users\\Ana\\AppData\\Local\\Programs\\omnirush.ai\\resources\\sidecars\\opencode.exe",
  });
}

function exitError(exitCode, output = "") {
  return Object.assign(new Error(`OmniRush server exited with code ${exitCode}${output ? `\n${output}` : ""}`), { exitCode });
}

test("start failures are classified from the error the start threw", () => {
  const cases = [
    [spawnError("ENOENT"), "engine_missing", "engine_spawn", "ENOENT", "binary_missing"],
    [spawnError("EPERM"), "engine_blocked", "engine_spawn", "EPERM", "spawn_blocked"],
    [spawnError("UNKNOWN", -4094), "engine_blocked", "engine_spawn", "UNKNOWN", "spawn_blocked"],
    [new Error("Timeout waiting for OmniRush server after 60000ms"), "engine_timeout", "engine_ready", null, "none"],
    [exitError(3221225501), "engine_cpu_unsupported", "engine_ready", null, "none"],
    [exitError(1, "CPU lacks AVX support. Please consider upgrading to a newer CPU."), "engine_cpu_unsupported", "engine_ready", null, "none"],
    [exitError(3221225506), "engine_blocked", "engine_ready", null, "exec_status_blocked"],
    [exitError(225), "engine_blocked", "engine_ready", null, "virus_detected"],
    [exitError(3221225477), "engine_crash", "engine_ready", null, "none"],
    [exitError(1, "error: Failed to start server. Is port 4096 in use? EADDRINUSE"), "port_in_use", "engine_ready", "EADDRINUSE", "none"],
    [exitError(1, "ConfigJsonError: C:\\Users\\Ana\\.config\\opencode\\opencode.json is not valid JSON"), "config_invalid", "engine_ready", null, "none"],
    [exitError(1, "SQLITE_CORRUPT: database disk image is malformed"), "store_error", "engine_ready", "SQLITE_CORRUPT", "none"],
    [exitError(1, "something else"), "engine_exit", "engine_ready", null, "none"],
    [new Error("Managed OmniRush process did not exit after SIGKILL"), "engine_stuck", "engine_ready", null, "none"],
    [new Error("Cannot find OmniRush.ai embedded server bundle. Checked: C:\\x"), "server_bundle_missing", "server", null, "none"],
    [new Error("OmniRush.ai server did not stay running after startup."), "server_not_ready", "server_ready", null, "none"],
    [Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }), "disk_full", "server", "ENOSPC", "none"],
    [Object.assign(new Error("Configuration is invalid"), { name: "OpencodeConfigCompatError" }), "config_incompatible", "server", null, "none"],
    [new Error("boom"), "unknown", "unknown", null, "none"],
  ];
  for (const [error, category, phase, errorCode, avHint] of cases) {
    const result = classifyStartFailure(error);
    assert.deepEqual(
      { category: result.category, phase: result.phase, errorCode: result.errorCode, avHint: result.avHint },
      { category, phase, errorCode, avHint },
      String(error instanceof Error ? error.message : error),
    );
  }
  const workspace = Object.assign(new Error("Workspace path is not accessible: D:\\Clients\\Acme"), {
    code: "workspace_inaccessible",
    cause: Object.assign(new Error("EPERM"), { code: "EPERM" }),
  });
  assert.deepEqual(
    (({ category, phase, errorCode }) => ({ category, phase, errorCode }))(classifyStartFailure(workspace)),
    { category: "workspace_inaccessible", phase: "workspace", errorCode: "EPERM" },
  );
  // A failed cleanup wraps the start error: the start error decides.
  const wrapped = new AggregateError([spawnError("ENOENT"), new Error("stop failed")], "startup failed");
  assert.equal(classifyStartFailure(wrapped).category, "engine_missing");
  assert.equal(classifyStartFailure(exitError(3221225477)).exitCode, 3221225477);
  assert.equal(classifyStartFailure("text").errorName, "none");
});

test("messages keep no paths, names, addresses or tokens", () => {
  const roots = ["C:\\Users\\Ana Lucía", "C:\\Users\\Ana Lucía\\AppData\\Roaming\\ai.omnirush.desktop"];
  const samples = [
    spawnError("ENOENT"),
    new Error("Workspace path is not accessible: C:\\Users\\Ana Lucía\\OneDrive\\Documents\\work"),
    new Error("EPERM: operation not permitted, open 'C:/Users/Ana Lucía/AppData/Roaming/omnirush/server.json'"),
    new Error("read \\\\fileserver\\profiles$\\ana\\x failed for ana@example.com"),
    new Error("cannot open /home/ana/.config/opencode/opencode.json (see https://example.com/help)"),
    new Error("token sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD rejected for user anaLucia"),
    exitError(1, "ConfigJsonError: ~/.config/opencode/opencode.json bad\nnpm error @opencode-ai/plugin failed"),
  ];
  for (const error of samples) {
    const text = scrubStartMessage(error, { roots, userName: "anaLucia" });
    assert.ok(text, error.message);
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]|\\\\|\/home\/|~[\\/]|@|https?:|Ana|ana|[A-Za-z0-9+/_-]{32,}/, text);
    assert.ok(text.length <= 300);
  }
  assert.equal(scrubStartMessage(spawnError("ENOENT"), { roots }), "spawn <path> ENOENT");
  assert.equal(scrubStartMessage(new Error("   ")), null);
  assert.match(scrubStartMessage(exitError(1, "line two\nerror: ConfigJsonError")), /exited with code 1 \| error: ConfigJsonError/);
});

test("profile, OS build and version fields are booleans or numbers only", () => {
  assert.deepEqual(profileFlags("C:\\Users\\José"), { non_ascii: true, has_space: false, unc: false, long: false });
  assert.deepEqual(profileFlags("C:\\Users\\Ana Lucia"), { non_ascii: false, has_space: true, unc: false, long: false });
  assert.equal(profileFlags("\\\\server\\profiles\\ana").unc, true);
  assert.equal(profileFlags(`C:\\Users\\${"x".repeat(90)}`).long, true);
  assert.equal(osBuild("10.0.26100"), "10.0.26100");
  assert.equal(osBuild("6.8.0-139-generic"), "6.8.0");
  assert.equal(osBuild("weird"), "unknown");
  assert.equal(reportVersion("v1.18.32"), "1.18.32");
  assert.equal(reportVersion("3.5.3-beta.1"), "3.5.3-beta.1");
  assert.equal(reportVersion(undefined), "unknown");
});

test("AVX2 detection per platform", async () => {
  assert.equal(await cpuHasAvx2({ platform: "linux", arch: "x64", readText: async () => "flags\t\t: fpu sse2 avx avx2 bmi2\n" }), true);
  assert.equal(await cpuHasAvx2({ platform: "linux", arch: "x64", readText: async () => "flags\t\t: fpu sse2 sse4_2\n" }), false);
  assert.equal(await cpuHasAvx2({ platform: "linux", arch: "arm64" }), null);
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, args.at(-1)]);
    return "False\r\n";
  };
  assert.equal(await cpuHasAvx2({ platform: "win32", arch: "x64", release: "10.0.22631", run }), false);
  assert.match(calls[0][1], /IsProcessorFeaturePresent\(40\)/);
  assert.equal(await cpuHasAvx2({ platform: "win32", arch: "x64", release: "10.0.17763", run }), null);
  assert.equal(await cpuHasAvx2({ platform: "win32", arch: "x64", release: "10.0.26100", run: async () => null }), null);
  assert.equal(await cpuHasAvx2({ platform: "darwin", arch: "x64", run: async () => "AVX2 BMI2 ERMS" }), true);
});

test("engine binary checks: missing, present and matching, modified", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "start-report-"));
  const binary = path.join(dir, "opencode.exe");
  const body = Buffer.concat([Buffer.from("MZ\x90\x00"), Buffer.alloc(64, 1)]);
  await writeFile(binary, body);
  const sha256 = createHash("sha256").update(body).digest("hex");

  const missing = await inspectEngineBinary({ resolved: null, bundledCandidates: [binary + ".gone"], platform: "win32" });
  assert.deepEqual(missing, { source: "missing", present: false, bundled_present: false, size: null, header_ok: null, hash_ok: null, readable: null });
  assert.equal(antivirusHint(classifyStartFailure(new Error("x")), missing), "binary_missing");
  assert.equal(antivirusHint(classifyStartFailure(new Error("x")), missing, { packaged: false }), "none");

  const ok = await inspectEngineBinary({
    resolved: { path: binary, source: "bundled" },
    bundledCandidates: [binary],
    versions: { opencode: { version: "1.18.32", sha256 } },
    platform: "win32",
  });
  assert.deepEqual(ok, { source: "bundled", present: true, bundled_present: true, size: body.length, header_ok: true, hash_ok: true, readable: true });
  assert.equal(antivirusHint(classifyStartFailure(new Error("x")), ok), "none");

  const modified = await inspectEngineBinary({
    resolved: { path: binary, source: "bundled" },
    bundledCandidates: [binary],
    versions: { opencode: { sha256: "0".repeat(64) } },
    platform: "linux",
  });
  assert.equal(modified.hash_ok, false);
  assert.equal(modified.header_ok, false);
  assert.equal(antivirusHint(classifyStartFailure(exitError(1)), modified), "binary_modified");
});

test("the report body carries only the server's fields", () => {
  const classified = classifyStartFailure(spawnError("ENOENT"));
  const engine = { source: "missing", present: false, bundled_present: false, size: null, header_ok: null, hash_ok: null, readable: null };
  const report = buildStartFailureReport({
    classified,
    engine,
    avHint: antivirusHint(classified, engine),
    cpuAvx2: true,
    message: "spawn <path> ENOENT",
    appVersion: "3.5.3",
    engineVersion: "1.18.32",
    electronVersion: "38.2.0",
    platform: "win32",
    arch: "x64",
    release: "10.0.26100",
    home: "C:\\Users\\José Ñ",
    elapsedMs: 1234.4,
    attempt: 2,
    occurredAt: new Date("2026-10-17T10:00:00Z"),
    eventId: "a".repeat(64),
  });
  assert.deepEqual(report, {
    schema_version: 1,
    product: "gui",
    kind: "start_failure",
    event_id: "a".repeat(64),
    occurred_at: "2026-10-17T10:00:00.000Z",
    app_version: "3.5.3",
    engine_version: "1.18.32",
    runtime: "electron",
    runtime_version: "38.2.0",
    platform: "win32",
    arch: "x64",
    os_build: "10.0.26100",
    phase: "engine_spawn",
    category: "engine_missing",
    error_name: "Error",
    error_code: "ENOENT",
    exit_code: null,
    signal: null,
    elapsed_ms: 1234,
    attempt: 2,
    engine,
    profile: { non_ascii: true, has_space: true, unc: false, long: false },
    cpu_avx2: true,
    av_hint: "binary_missing",
    message: "spawn <path> ENOENT",
  });
  assert.doesNotMatch(JSON.stringify(report), /José|Users/);
  // ENOENT although the binary is there: something stopped it.
  const blocked = buildStartFailureReport({ classified, engine: { ...engine, present: true, bundled_present: true }, avHint: "spawn_blocked", appVersion: "3.5.3" });
  assert.equal(blocked.category, "engine_blocked");
  const modified = buildStartFailureReport({ classified: classifyStartFailure(exitError(1)), engine, avHint: "binary_modified", appVersion: "x" });
  assert.equal(modified.category, "engine_modified");
  assert.equal(modified.app_version, "unknown");
});

test("hints name the antivirus fix on Windows and stay null for unknown failures", () => {
  assert.match(startFailureHint("engine_missing", { platform: "win32" }).body, /Protection history/);
  assert.match(startFailureHint("unknown", { platform: "win32", avHint: "binary_missing" }).title, /antivirus/);
  assert.match(startFailureHint("engine_timeout", { platform: "win32" }).body, /exclusion/);
  assert.match(startFailureHint("store_error").body, /Reset app data/);
  assert.equal(startFailureHint("unknown"), null);
  assert.equal(startFailureHint("renderer"), null);
});

function response(status) {
  return { ok: status >= 200 && status < 300, status };
}

test("reporter: once sent, queued while signed out, capped per day, flushed later", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "start-reporter-"));
  const filePath = path.join(dir, "start-reports.json");
  let nowMs = Date.parse("2026-10-17T10:00:00Z");
  const sent = [];
  let answer = null;
  const reporter = createStartReporter({
    filePath,
    now: () => nowMs,
    maxPerDay: 3,
    send: async (body) => {
      sent.push(body.event_id);
      return answer;
    },
  });
  const body = (id) => ({ event_id: id, occurred_at: new Date(nowMs).toISOString() });

  // Signed out: queued.
  assert.equal(await reporter.report(body("a")), "queued");
  answer = response(201);
  assert.equal(await reporter.report(body("b")), "sent");
  answer = response(400);
  assert.equal(await reporter.report(body("c")), "dropped");
  // The day's cap counts every attempt.
  assert.equal(await reporter.report(body("d")), "skipped");
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")).queue.map((item) => item.event_id), ["a"]);

  // Next day, offline: queued; the next start's flush sends both.
  nowMs += 24 * 60 * 60 * 1000;
  answer = null;
  assert.equal(await reporter.report(body("e")), "queued");
  answer = response(201);
  assert.deepEqual(await reporter.flush(), { sent: 2, queued: 0 });
  assert.deepEqual(sent, ["a", "b", "c", "e", "a", "e"]);

  // A server error keeps the queue; reports older than six days are dropped.
  answer = response(503);
  assert.equal(await reporter.report(body("f")), "queued");
  nowMs += 7 * 24 * 60 * 60 * 1000;
  assert.deepEqual(await reporter.flush(), { sent: 0, queued: 0 });

  // A failing transport never throws.
  const failing = createStartReporter({ filePath: path.join(dir, "other.json"), send: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(await failing.report(body("g")), "queued");
});
