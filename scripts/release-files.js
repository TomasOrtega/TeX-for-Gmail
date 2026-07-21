#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");

const FORBIDDEN_SEGMENTS = Object.freeze(new Set([
  ".git",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "node_modules"
]));
const FORBIDDEN_BASENAMES = Object.freeze(new Set([
  ".ds_store",
  "thumbs.db"
]));
const SENSITIVE_BASENAMES = Object.freeze(new Set([
  ".env",
  ".npmrc",
  "id_dsa",
  "id_ed25519",
  "id_rsa"
]));
const SENSITIVE_EXTENSIONS = Object.freeze(new Set([
  ".key",
  ".p12",
  ".pem",
  ".pfx"
]));

function fail(message) {
  throw new Error(message);
}

function compareNames(left, right) {
  if (left < right)
    return -1;
  if (left > right)
    return 1;
  return 0;
}

function runGit(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024
  });
}

function normalizeRepositoryPath(filename) {
  const segments = typeof filename === "string" ? filename.split("/") : [];
  if (typeof filename !== "string" ||
      filename.length === 0 ||
      filename.includes("\0") ||
      filename.includes("\\") ||
      path.posix.isAbsolute(filename) ||
      path.posix.normalize(filename) !== filename ||
      segments.some(segment => segment === "." || segment === "..")) {
    fail(`Git reported an unsafe path: ${JSON.stringify(filename)}`);
  }
  return filename;
}

function listTrackedFiles({
  root = path.join(__dirname, ".."),
  git = runGit
} = {}) {
  let output;
  try {
    output = git(root, ["ls-files", "-z", "--cached"]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`Cannot determine tracked files with Git: ${reason}`);
  }
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
  const filenames = buffer.toString("utf8").split("\0");
  if (filenames.at(-1) === "")
    filenames.pop();
  return filenames.map(normalizeRepositoryPath).sort(compareNames);
}

function hasSensitiveName(filename) {
  const basename = path.posix.basename(filename).toLowerCase();
  return SENSITIVE_BASENAMES.has(basename) ||
    basename.startsWith(".env.") ||
    SENSITIVE_EXTENSIONS.has(path.posix.extname(basename));
}

function isSafeReleaseFile(filename) {
  const normalized = normalizeRepositoryPath(filename);
  const segments = normalized.split("/");
  const basename = segments.at(-1).toLowerCase();
  return !segments.some(segment =>
    FORBIDDEN_SEGMENTS.has(segment.toLowerCase())
  ) &&
    !FORBIDDEN_BASENAMES.has(basename) &&
    path.posix.extname(basename) !== ".log" &&
    !hasSensitiveName(normalized);
}

module.exports = {
  compareNames,
  isSafeReleaseFile,
  listTrackedFiles,
  normalizeRepositoryPath,
  runGit
};
