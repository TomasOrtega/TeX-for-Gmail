#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const lockPath = path.join(root, "artifacts.lock.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

function resolve(relativePath) {
  if (typeof relativePath !== "string" ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).includes(".."))
    throw new Error(`Unsafe lock path: ${relativePath}`);
  return path.join(root, relativePath);
}

function walk(relativeDirectory) {
  const directory = resolve(relativeDirectory);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory())
      return walk(relative);
    if (!entry.isFile())
      throw new Error(`Artifact tree contains a non-file: ${relative}`);
    return [relative];
  });
}

function describe(relativePath) {
  const filename = resolve(relativePath);
  const contents = fs.readFileSync(filename);
  return {
    path: relativePath,
    size: contents.byteLength,
    sha256: crypto.createHash("sha256").update(contents).digest("hex")
  };
}

let total = 0;
for (const component of lock.components) {
  const paths = new Set(component.lockPaths || []);
  for (const tree of component.lockTrees || []) {
    for (const filename of walk(tree))
      paths.add(filename);
  }
  component.files = [...paths].sort().map(describe);
  total += component.files.length;
}

fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Locked ${total} generated and vendored artifacts.`);
