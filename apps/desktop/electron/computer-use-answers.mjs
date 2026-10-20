// Whether a rig may answer computer use questions without a physical press (remote-debugging clicks).
// Only in a build run from source: a packaged app ignores OMNIRUSH_COMPUTER_USE_TEST_ANSWERS, so relaunching
// it with that environment can never approve on the person's behalf.
/**
 * @param {Record<string, string | undefined> | undefined} env
 * @param {boolean} isPackaged
 * @param {(message: string) => void} [warn]
 */
export function testAnswersAllowed(env, isPackaged, warn = () => {}) {
  if (env?.OMNIRUSH_COMPUTER_USE_TEST_ANSWERS !== "1") return false;
  if (isPackaged) { warn("OMNIRUSH_COMPUTER_USE_TEST_ANSWERS is ignored in a packaged app."); return false; }
  return true;
}
