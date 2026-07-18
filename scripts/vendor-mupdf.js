#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const packageRoot = path.join(root, "node_modules", "mupdf");
const destination = path.join(
  root,
  "chrome-extension",
  "resources",
  "mupdf"
);
const metadata = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
);
const checkOnly = process.argv.includes("--check");

if (metadata.version !== "1.28.0")
  throw new Error(`Expected mupdf 1.28.0, found ${metadata.version}`);
if (metadata.license !== "AGPL-3.0-or-later")
  throw new Error(`Unexpected MuPDF license: ${metadata.license}`);

if (!checkOnly)
  fs.mkdirSync(destination, { recursive: true });
for (const filename of [
  "dist/mupdf.js",
  "dist/mupdf-wasm.js",
  "dist/mupdf-wasm.wasm",
  "LICENSE",
  "package.json"
]) {
  const source = path.join(packageRoot, filename);
  const target = path.join(destination, path.basename(filename));
  if (checkOnly) {
    if (!fs.existsSync(target) ||
        !fs.readFileSync(source).equals(fs.readFileSync(target)))
      throw new Error(`Vendored MuPDF file is stale: ${path.basename(filename)}`);
  } else {
    fs.copyFileSync(source, target);
  }
}

console.log(
  checkOnly
    ? `Verified vendored MuPDF ${metadata.version}.`
    : `Vendored MuPDF ${metadata.version}.`
);
