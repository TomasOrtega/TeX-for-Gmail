#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TARGETS = Object.freeze(["firefox", "chrome"]);
const FIXED_MTIME = new Date("2000-01-01T00:00:00.000Z");
const ZIP_DOS_TIMESTAMP = (
  ((2000 - 1980) << 25) |
  (1 << 21) |
  (1 << 16)
) >>> 0;
const EXCLUDED_FILES = Object.freeze({
  firefox: new Set([
    "icons/icon-128.png",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "manifest.json",
    "src/chrome-offscreen.html",
    "src/chrome-service-worker.js"
  ]),
  chrome: new Set([
    "icons/icon.svg",
    "manifest.json",
    "src/background.html"
  ])
});

function fail(message) {
  throw new Error(message);
}

function readJson(filename, label = filename) {
  let contents;
  try {
    contents = fs.readFileSync(filename, "utf8");
  } catch (error) {
    fail(`Cannot read ${label}: ${error.message}`);
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function requireTarget(target) {
  if (!TARGETS.includes(target))
    fail(`Unknown extension target "${target}". Expected: ${TARGETS.join(", ")}`);
  return target;
}

function compareNames(left, right) {
  if (left < right)
    return -1;
  if (left > right)
    return 1;
  return 0;
}

function getTargetConfig({
  root = path.join(__dirname, ".."),
  target
}) {
  requireTarget(target);
  const manifestPath = path.join(root, "targets", target, "manifest.json");
  let manifestStats;
  try {
    manifestStats = fs.lstatSync(manifestPath);
  } catch (error) {
    fail(`Cannot inspect ${target} target manifest: ${error.message}`);
  }
  if (manifestStats.isSymbolicLink() || !manifestStats.isFile())
    fail(`${target} target manifest must be a regular file`);

  const manifest = readJson(
    manifestPath,
    `${target} target manifest`
  );
  const packageJson = readJson(
    path.join(root, "package.json"),
    "package.json"
  );
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    fail(`${target} target manifest must contain a JSON object`);
  if (!packageJson ||
      typeof packageJson !== "object" ||
      Array.isArray(packageJson))
    fail("package.json must contain a JSON object");

  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || ""))
    fail(`${target} manifest must use a three-part numeric release version`);
  if (manifest.version !== packageJson.version)
    fail(`package.json and ${target} manifest versions differ`);

  return {
    root,
    target,
    manifest,
    manifestPath,
    sourceRoot: path.join(root, "chrome-extension"),
    stageRoot: path.join(root, "build", target),
    archivePath: path.join(
      root,
      "dist",
      `tex-for-gmail-${target}-${manifest.version}.zip`
    ),
    excludedFiles: EXCLUDED_FILES[target]
  };
}

function walkFiles(directory, {
  base = directory,
  excludedFiles = new Set()
} = {}) {
  if (!fs.existsSync(directory))
    fail(`Directory does not exist: ${directory}`);

  const files = new Map();
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareNames(left.name, right.name));

  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    const relative = path.relative(base, filename).split(path.sep).join("/");
    if (excludedFiles.has(relative))
      continue;
    if (entry.isSymbolicLink())
      fail(`Extension source contains a symlink: ${relative}`);
    if (entry.isDirectory()) {
      for (const [name, contents] of walkFiles(filename, {
        base,
        excludedFiles
      }))
        files.set(name, contents);
    } else if (entry.isFile()) {
      files.set(relative, fs.readFileSync(filename));
    } else {
      fail(`Extension source contains a non-regular file: ${relative}`);
    }
  }
  return files;
}

function expectedTargetFiles(config) {
  const files = walkFiles(config.sourceRoot, {
    excludedFiles: config.excludedFiles
  });
  files.set("manifest.json", fs.readFileSync(config.manifestPath));
  return new Map([...files].sort(([left], [right]) =>
    compareNames(left, right)
  ));
}

function parseTargetArguments(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--all"))
    return [...TARGETS];
  if (argv.length === 1)
    return [requireTarget(argv[0])];
  fail(`Usage: ${path.basename(process.argv[1])} [${TARGETS.join("|")}|--all]`);
}

module.exports = {
  FIXED_MTIME,
  TARGETS,
  ZIP_DOS_TIMESTAMP,
  expectedTargetFiles,
  getTargetConfig,
  parseTargetArguments,
  walkFiles
};
