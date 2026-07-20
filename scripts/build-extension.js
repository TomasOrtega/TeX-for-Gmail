#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  parseTargetArguments,
  walkFiles
} = require("./extension-targets.js");
const { writeDeterministicZip } = require("./deterministic-zip.js");
const { stageTarget } = require("./stage-extension.js");
const { verifyTargetZip } = require("./verify-zip.js");

function buildTarget({
  root = path.join(__dirname, ".."),
  target,
  trackedFiles,
  quiet = false
}) {
  const config = stageTarget({ root, target, trackedFiles, quiet: true });
  const files = walkFiles(config.stageRoot);
  writeDeterministicZip(config.archivePath, files);
  const result = verifyTargetZip({
    root,
    target,
    trackedFiles,
    archivePath: config.archivePath,
    quiet: true
  });

  if (!quiet)
    console.log(
      `Built ${path.relative(root, config.archivePath)} ` +
      `(${result.verified} files, ${result.bytes} bytes).`
    );
  return result;
}

function main(argv = process.argv.slice(2)) {
  for (const target of parseTargetArguments(argv))
    buildTarget({ target });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildTarget };
