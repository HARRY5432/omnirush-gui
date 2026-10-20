import assert from "node:assert/strict";
import test from "node:test";

import { testAnswersAllowed } from "./computer-use-answers.mjs";

test("computer use test answers: only a build run from source honours the switch", () => {
  const warnings = [];
  assert.equal(testAnswersAllowed({ OMNIRUSH_COMPUTER_USE_TEST_ANSWERS: "1" }, true, (m) => warnings.push(m)), false);
  assert.equal(warnings.length, 1);
  assert.equal(testAnswersAllowed({ OMNIRUSH_COMPUTER_USE_TEST_ANSWERS: "1" }, false), true);
  assert.equal(testAnswersAllowed({}, false), false);
  assert.equal(testAnswersAllowed({ OMNIRUSH_COMPUTER_USE_TEST_ANSWERS: "true" }, false), false);
});
