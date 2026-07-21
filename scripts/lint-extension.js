#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { stageTarget } = require("./stage-extension.js");

const EXPECTED_WARNINGS = Object.freeze([
  Object.freeze({
    code: "DANGEROUS_EVAL",
    file: "resources/mathjax/input/tex/extensions/begingroup.js",
    count: 1
  }),
  Object.freeze({
    code: "DANGEROUS_EVAL",
    file: "resources/mathjax/input/tex/extensions/boldsymbol.js",
    count: 1
  }),
  Object.freeze({
    code: "DANGEROUS_EVAL",
    file: "resources/mathjax/tex-svg.js",
    count: 1
  }),
  Object.freeze({
    code: "UNSAFE_VAR_ASSIGNMENT",
    file: "resources/mathjax/tex-svg.js",
    count: 7
  })
]);

function fail(message) {
  throw new Error(message);
}

function sha256(filename) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filename))
    .digest("hex");
}

function warningKey(warning) {
  return [warning.code, warning.file].join(":");
}

function warningLabel(warning) {
  return `${warning.code} in ${warning.file}`;
}

function artifactDigests(root) {
  const filename = path.join(root, "artifacts.lock.json");
  const lock = JSON.parse(fs.readFileSync(filename, "utf8"));
  const digests = new Map();

  for (const component of lock.components || []) {
    for (const artifact of component.files || []) {
      if (digests.has(artifact.path))
        fail(`Artifact is listed more than once: ${artifact.path}`);
      if (!/^[0-9a-f]{64}$/.test(artifact.sha256 || ""))
        fail(`Invalid locked SHA-256 for ${artifact.path}`);
      digests.set(artifact.path, artifact.sha256);
    }
  }
  return digests;
}

function requireReportList(report, name) {
  if (!Array.isArray(report?.[name]))
    fail(`addons-linter JSON report is missing its ${name} list`);
  return report[name];
}

function verifyWarningFiles({ root, sourceDir, warnings }) {
  const digests = artifactDigests(root);
  const files = new Set(warnings.map(warning => warning.file));

  for (const relative of files) {
    if (typeof relative !== "string" ||
        path.isAbsolute(relative) ||
        relative.includes("\\") ||
        relative.split("/").includes(".."))
      fail(`Unsafe lint warning path: ${relative}`);

    const artifactPath = `chrome-extension/${relative}`;
    const expected = digests.get(artifactPath);
    if (!expected)
      fail(`Lint warning file is not integrity-locked: ${relative}`);

    const filename = path.join(sourceDir, ...relative.split("/"));
    let actual;
    try {
      actual = sha256(filename);
    } catch (error) {
      fail(`Cannot verify lint warning file ${relative}: ${error.message}`);
    }
    if (actual !== expected)
      fail(
        `SHA-256 mismatch for lint warning file ${relative}: ` +
        `expected ${expected}, got ${actual}`
      );
  }
}

function validateLintReport({ report, root, sourceDir }) {
  const errors = requireReportList(report, "errors");
  const notices = requireReportList(report, "notices");
  const warnings = requireReportList(report, "warnings");

  if (errors.length !== 0)
    fail(`addons-linter reported ${errors.length} error(s)`);
  if (notices.length !== 0)
    fail(`addons-linter reported ${notices.length} unexpected notice(s)`);

  const expectedCounts = new Map();
  for (const warning of EXPECTED_WARNINGS) {
    const key = warningKey(warning);
    expectedCounts.set(key, warning.count);
  }

  for (const warning of warnings) {
    const key = warningKey(warning);
    const remaining = expectedCounts.get(key) || 0;
    if (remaining === 0)
      fail(`Unexpected addons-linter warning: ${warningLabel(warning)}`);
    expectedCounts.set(key, remaining - 1);
  }

  const missing = EXPECTED_WARNINGS.find(warning =>
    (expectedCounts.get(warningKey(warning)) || 0) > 0
  );
  if (missing)
    fail(`Expected addons-linter warning is missing: ${warningLabel(missing)}`);

  verifyWarningFiles({ root, sourceDir, warnings });
  return { warnings: warnings.length };
}

function runAddonsLinter({
  root,
  sourceDir,
  spawn = spawnSync
}) {
  const executable = path.join(
    root,
    "node_modules",
    "addons-linter",
    "bin",
    "addons-linter"
  );
  const result = spawn(process.execPath, [
    executable,
    "--output",
    "json",
    "--boring",
    sourceDir
  ], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });

  if (result.error)
    fail(`Cannot run addons-linter: ${result.error.message}`);
  let report;
  try {
    report = JSON.parse((result.stdout || "").trim());
  } catch (error) {
    const detail = (result.stderr || "").trim();
    fail(
      `addons-linter did not return valid JSON: ${error.message}` +
      (detail ? ` (${detail})` : "")
    );
  }

  return {
    report,
    status: result.status
  };
}

function lintFirefox({
  root = path.join(__dirname, ".."),
  quiet = false,
  run = runAddonsLinter,
  stage = stageTarget
} = {}) {
  const config = stage({ root, target: "firefox", quiet: true });
  const result = run({ root, sourceDir: config.stageRoot });
  const validated = validateLintReport({
    report: result.report,
    root,
    sourceDir: config.stageRoot
  });
  if (result.status !== 0)
    fail(`addons-linter exited with status ${result.status}`);

  if (!quiet)
    console.log(
      `Firefox lint passed with ${validated.warnings} ` +
      "integrity-locked upstream warning(s)."
    );
  return validated;
}

function main() {
  lintFirefox();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPECTED_WARNINGS,
  artifactDigests,
  lintFirefox,
  runAddonsLinter,
  validateLintReport,
  verifyWarningFiles,
  warningKey
};
