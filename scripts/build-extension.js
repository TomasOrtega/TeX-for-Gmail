#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const AdmZip = require("adm-zip");
const {
  ZIP_DOS_TIMESTAMP,
  parseTargetArguments,
  walkFiles
} = require("./extension-targets.js");
const { stageTarget } = require("./stage-extension.js");
const { verifyTargetZip } = require("./verify-zip.js");

const ZIP_STORED_METHOD = 0;

function buildTarget({
  root = path.join(__dirname, ".."),
  target,
  trackedFiles,
  quiet = false
}) {
  const config = stageTarget({ root, target, trackedFiles, quiet: true });
  const files = walkFiles(config.stageRoot);
  const archive = new AdmZip({ noSort: true });

  for (const [relative, contents] of files) {
    const entry = archive.addFile(relative, contents, "", 0o644);
    entry.header.timeval = ZIP_DOS_TIMESTAMP;
    entry.header.method = ZIP_STORED_METHOD;
  }

  fs.mkdirSync(path.dirname(config.archivePath), {
    mode: 0o755,
    recursive: true
  });
  fs.writeFileSync(config.archivePath, archive.toBuffer(), { mode: 0o644 });
  fs.chmodSync(config.archivePath, 0o644);
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
