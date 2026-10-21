// check-packaged-engine.mjs <resources-dir>: run with the PACKAGED app's own runtime
// (ELECTRON_RUN_AS_NODE=1 <app executable> check-packaged-engine.mjs <resources>), after packaging and
// signing, on the final artifact. It runs the app's own engine checks against the app's own files:
// Electron main's (electron/build-variant.mjs, the one that shows "The bundled engine was changed")
// and the local server's (server/dist/release-guard.js). Both must accept every bundled engine, so a
// build whose stamp no longer matches its (signed) engine cannot ship. Exit 1 on any failure.
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const resources = path.resolve(process.argv[2] || process.resourcesPath || "");
const asar = path.join(resources, "app.asar");
const fail = (message) => { console.error(`check-packaged-engine: ${message}`); process.exit(1); };

const variant = await import(pathToFileURL(path.join(asar, "electron", "build-variant.mjs")).href);
const build = variant.readDesktopBuild({ resourcesPath: resources });
if (build.variant !== "release") fail(`expected a release build, found "${build.variant}"`);
if (!build.engineSha256) fail("the build records no engine sha256");

const sidecars = path.join(resources, "sidecars");
const engines = readdirSync(sidecars).filter((name) => /^opencode(?:-[a-z0-9_-]+)?(?:\.exe)?$/.test(name) && !/^opencode-v\d|^opencode2/.test(name));
if (!engines.length) fail(`no bundled engine in ${sidecars}`);

const guard = await import(pathToFileURL(path.join(asar, "server", "dist", "release-guard.js")).href);
for (const name of engines) {
  try {
    variant.releaseEngineBinary({ build, resourcesPath: resources, fileNames: [name] });
  } catch (error) {
    fail(`Electron main refuses ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    // Its own stamped build facts (server/dist/build-variant.js), not Electron main's.
    await guard.releaseEngineBinary(path.join(sidecars, name));
  } catch (error) {
    fail(`the local server refuses ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`check-packaged-engine: ${name} accepted by Electron main and the local server`);
}
