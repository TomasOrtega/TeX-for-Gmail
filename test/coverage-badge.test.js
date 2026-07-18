"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  coreCoverage,
  discoverCoreSources,
  requireCompleteCoverage
} = require("../scripts/coverage-badge.js");

function lcovRecord(source, hit = 2, total = 2) {
  return [
    `SF:${source}`,
    `LF:${total}`,
    `LH:${hit}`,
    "end_of_record"
  ].join("\n");
}

test("core coverage discovers every authored runtime script", () => {
  const sources = discoverCoreSources();

  assert.deepEqual(sources, [
    "chrome-extension/popup/popup.js",
    "chrome-extension/src/background.js",
    "chrome-extension/src/chrome-service-worker.js",
    "chrome-extension/src/communicator.js",
    "chrome-extension/src/contentscr.js",
    "chrome-extension/src/controller.js",
    "chrome-extension/src/latex.js",
    "chrome-extension/src/mupdfworker.js",
    "chrome-extension/src/pdftexworker.js",
    "chrome-extension/src/pool.js",
    "chrome-extension/src/portwrapper.js",
    "chrome-extension/src/utils.js"
  ]);
});

test("core coverage ignores non-runtime LCOV records", () => {
  const sources = discoverCoreSources();
  const lcov = [
    lcovRecord("scripts/uncovered.js", 0, 100),
    ...sources.map(source => lcovRecord(source))
  ].join("\n");

  const coverage = coreCoverage(lcov);

  assert.deepEqual(coverage, {
    hit: sources.length * 2,
    percent: 100,
    total: sources.length * 2
  });
  assert.doesNotThrow(() => requireCompleteCoverage(coverage));
});

test("core coverage rejects missing or uncovered runtime lines", () => {
  const sources = discoverCoreSources();
  const missing = sources.slice(1)
    .map(source => lcovRecord(source))
    .join("\n");
  assert.throws(
    () => coreCoverage(missing),
    /missing required sources/i
  );

  const incomplete = sources.map((source, index) =>
    lcovRecord(source, index === 0 ? 1 : 2)
  ).join("\n");
  assert.throws(
    () => requireCompleteCoverage(coreCoverage(incomplete)),
    /expected 100%/i
  );
});
