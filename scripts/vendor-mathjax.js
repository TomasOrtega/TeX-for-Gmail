#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const destinationRoot = path.join(
  root,
  "chrome-extension",
  "resources",
  "mathjax"
);
const { MathJaxNewcmFont } = require(
  "@mathjax/mathjax-newcm-font/cjs/svg.js"
);

function dynamicFontNames() {
  const names = Object.values(MathJaxNewcmFont.dynamicFiles)
    .map(({ file }) => file);
  if (!names.length ||
      names.some(name => !/^[A-Za-z0-9-]+$/.test(name)) ||
      new Set(names).size !== names.length) {
    throw new Error("MathJax contains an invalid dynamic SVG font map.");
  }
  return names.sort();
}

const files = Object.freeze([
  {
    packageName: "@mathjax/src",
    source: "bundle/tex-svg.js",
    destination: "tex-svg.js"
  },
  {
    packageName: "@mathjax/src",
    source: "bundle/input/tex/extensions/boldsymbol.js",
    destination: "input/tex/extensions/boldsymbol.js"
  },
  {
    packageName: "@mathjax/src",
    source: "bundle/input/tex/extensions/begingroup.js",
    destination: "input/tex/extensions/begingroup.js"
  },
  {
    packageName: "@mathjax/src",
    source: "LICENSE",
    destination: "LICENSE"
  },
  ...dynamicFontNames().map(name => ({
    packageName: "@mathjax/mathjax-newcm-font",
    source: `svg/dynamic/${name}.js`,
    destination: `mathjax-newcm-font/svg/dynamic/${name}.js`
  }))
]);

function packageRoot(packageName) {
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

function expectedFiles() {
  return files.map(file => ({
    destination: path.join(destinationRoot, ...file.destination.split("/")),
    relative: file.destination,
    source: path.join(
      packageRoot(file.packageName),
      ...file.source.split("/")
    )
  }));
}

function walk(directory, base = directory) {
  if (!fs.existsSync(directory))
    return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory())
      return walk(filename, base);
    if (!entry.isFile())
      throw new Error(`MathJax vendor tree contains a non-file: ${filename}`);
    return [path.relative(base, filename).split(path.sep).join("/")];
  });
}

function check() {
  const expected = expectedFiles();
  const expectedNames = expected.map(file => file.relative).sort();
  const actualNames = walk(destinationRoot).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
    throw new Error("Packaged MathJax file list differs from the vendor set.");

  for (const file of expected) {
    if (!fs.readFileSync(file.destination).equals(fs.readFileSync(file.source)))
      throw new Error(`Packaged MathJax file differs: ${file.relative}`);
  }
  return expected.length;
}

function vendor() {
  const expected = expectedFiles();
  fs.rmSync(destinationRoot, { force: true, recursive: true });
  for (const file of expected) {
    fs.mkdirSync(path.dirname(file.destination), {
      mode: 0o755,
      recursive: true
    });
    fs.copyFileSync(file.source, file.destination);
    fs.chmodSync(file.destination, 0o644);
  }
  return check();
}

function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--check"))
    throw new Error("Usage: vendor-mathjax.js [--check]");
  const checking = argv[0] === "--check";
  const count = checking ? check() : vendor();
  console.log(
    `${checking ? "Verified" : "Vendored"} ${count} exact MathJax files.`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { check, files, vendor };
