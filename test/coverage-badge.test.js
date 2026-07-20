"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

test("coverage command includes nested authored runtime scripts", () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "package.json"),
    "utf8"
  ));

  assert.ok(packageJson.scripts["test:coverage"].includes(
    '--test-coverage-include="chrome-extension/src/**/*.js"'
  ));
});

test("core coverage discovers every authored runtime script", () => {
  const sources = discoverCoreSources();

  assert.deepEqual(sources, [
    "chrome-extension/src/background.js",
    "chrome-extension/src/chrome-service-worker.js",
    "chrome-extension/src/communicator.js",
    "chrome-extension/src/contentscr.js",
    "chrome-extension/src/controller.js",
    "chrome-extension/src/latex.js",
    "chrome-extension/src/portwrapper.js"
  ]);
});

test("core coverage discovers nested authored runtime scripts", t => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tex-gmail-coverage-")
  );
  t.after(() => fs.rmSync(temporaryRoot, { force: true, recursive: true }));
  const sourceRoot = path.join(temporaryRoot, "chrome-extension", "src");
  fs.mkdirSync(path.join(sourceRoot, "nested", "deeper"), {
    recursive: true
  });
  fs.writeFileSync(path.join(sourceRoot, "top.js"), "");
  fs.writeFileSync(path.join(sourceRoot, "nested", "runtime.js"), "");
  fs.writeFileSync(path.join(sourceRoot, "nested", "deeper", "runtime.js"), "");
  fs.writeFileSync(path.join(sourceRoot, "nested", "ignored.css"), "");

  assert.deepEqual(discoverCoreSources(temporaryRoot), [
    "chrome-extension/src/nested/deeper/runtime.js",
    "chrome-extension/src/nested/runtime.js",
    "chrome-extension/src/top.js"
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
