#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const packageRoot = process.env.BROWSERFS_PACKAGE_ROOT ||
  path.join(root, "node_modules", "browserfs");
const destination = path.join(
  root,
  "chrome-extension",
  "resources",
  "browserfs"
);
const scriptDestination = path.join(
  root,
  "chrome-extension",
  "resources",
  "scripts",
  "browserfs.min.js"
);
const metadata = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
);
const checkOnly = process.argv.includes("--check");

if (metadata.version !== "2.0.0")
  throw new Error(`Expected BrowserFS 2.0.0, found ${metadata.version}`);
if (metadata.license !== "MIT")
  throw new Error(`Unexpected BrowserFS license: ${metadata.license}`);

const unsafeGlobal =
  'var n;n=function(){return this}();try{n=n||Function("return this")()||(0,eval)("this")}catch(t){"object"==typeof window&&(n=window)}t.exports=n';
const safeGlobal =
  'var n="object"==typeof globalThis?globalThis:"object"==typeof self?self:"object"==typeof window?window:{};t.exports=n';
const unsafeLodashGlobal =
  'yn=ln||dn||Function("return this")(),gn=yn.Symbol';
const safeLodashGlobal =
  'yn=ln||dn||("object"==typeof globalThis?globalThis:{}),gn=yn.Symbol';
const upstream = fs.readFileSync(
  path.join(packageRoot, "dist", "browserfs.min.js"),
  "utf8"
);
if (upstream.split(unsafeGlobal).length !== 2)
  throw new Error("BrowserFS CSP patch no longer matches exactly once");
if (upstream.split(unsafeLodashGlobal).length !== 2)
  throw new Error("BrowserFS lodash CSP patch no longer matches exactly once");
const patched = upstream
  .replace(unsafeGlobal, safeGlobal)
  .replace(unsafeLodashGlobal, safeLodashGlobal);
if (/\beval\s*\(|\bFunction\s*\(\s*["']/.test(patched))
  throw new Error("Patched BrowserFS still contains dynamic evaluation");

const vendored = new Map([
  ["LICENSE", fs.readFileSync(path.join(packageRoot, "LICENSE"))],
  ["package.json", fs.readFileSync(path.join(packageRoot, "package.json"))]
]);

if (checkOnly) {
  if (!fs.existsSync(scriptDestination) ||
      fs.readFileSync(scriptDestination, "utf8") !== patched)
    throw new Error("Vendored BrowserFS script is stale");
  for (const [filename, contents] of vendored) {
    const target = path.join(destination, filename);
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(contents))
      throw new Error(`Vendored BrowserFS file is stale: ${filename}`);
  }
} else {
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(scriptDestination, patched);
  for (const [filename, contents] of vendored)
    fs.writeFileSync(path.join(destination, filename), contents);
}

console.log(
  checkOnly
    ? `Verified vendored BrowserFS ${metadata.version}.`
    : `Vendored BrowserFS ${metadata.version}.`
);
