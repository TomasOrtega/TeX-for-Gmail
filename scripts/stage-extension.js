#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  FIXED_MTIME,
  expectedTargetFiles,
  getTargetConfig,
  parseTargetArguments
} = require("./extension-targets.js");

function setTreeTimes(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory())
      setTreeTimes(filename);
    fs.utimesSync(filename, FIXED_MTIME, FIXED_MTIME);
  }
  fs.chmodSync(directory, 0o755);
  fs.utimesSync(directory, FIXED_MTIME, FIXED_MTIME);
}

function stageTarget({
  root = path.join(__dirname, ".."),
  target,
  trackedFiles,
  quiet = false
}) {
  const config = getTargetConfig({ root, target });
  const files = expectedTargetFiles(config, { trackedFiles });
  fs.rmSync(config.stageRoot, { force: true, recursive: true });
  fs.mkdirSync(config.stageRoot, { mode: 0o755, recursive: true });

  let bytes = 0;
  for (const [relative, contents] of files) {
    const destination = path.join(config.stageRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { mode: 0o755, recursive: true });
    fs.writeFileSync(destination, contents, { mode: 0o644 });
    fs.chmodSync(destination, 0o644);
    bytes += contents.byteLength;
  }
  setTreeTimes(config.stageRoot);

  if (!quiet)
    console.log(`Staged ${target} (${files.size} files, ${bytes} bytes).`);
  return { ...config, bytes, staged: files.size };
}

function main(argv = process.argv.slice(2)) {
  for (const target of parseTargetArguments(argv))
    stageTarget({ target });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { stageTarget };
