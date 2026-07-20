#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const AdmZip = require("adm-zip");
const {
  expectedTargetFiles,
  getTargetConfig,
  parseTargetArguments,
  walkFiles
} = require("./extension-targets.js");

const MAX_ARCHIVE_FILES = 10000;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function requireSafeEntry(entry) {
  const name = entry.entryName;
  if (!name ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.startsWith("/") ||
      name.split("/").includes(".."))
    fail(`Release ZIP contains an unsafe path: ${name}`);

  const mode = (entry.header.attr >>> 16) & 0xffff;
  if ((mode & 0o170000) === 0o120000)
    fail(`Release ZIP contains a symlink: ${name}`);
}

function selectArchive(root, extensionRoot) {
  const dist = path.join(root, "dist");
  const candidates = fs.existsSync(dist)
    ? fs.readdirSync(dist)
      .filter(filename => filename.endsWith(".zip"))
      .map(filename => path.join(dist, filename))
    : [];
  if (candidates.length === 1)
    return candidates[0];

  const expectedManifest = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8")
  );
  const matching = candidates.filter(filename => {
    try {
      const entry = new AdmZip(filename).getEntry("manifest.json");
      if (!entry)
        return false;
      const manifest = JSON.parse(entry.getData().toString("utf8"));
      return manifest.name === expectedManifest.name &&
        manifest.version === expectedManifest.version;
    } catch {
      return false;
    }
  });
  if (matching.length !== 1)
    fail("Expected exactly one built ZIP for the current extension version");
  return matching[0];
}

function verifyFileTree(expectedFiles, directory, label) {
  const actualFiles = walkFiles(directory);
  for (const [filename, contents] of actualFiles) {
    const expected = expectedFiles.get(filename);
    if (!expected)
      fail(`${label} contains an unexpected file: ${filename}`);
    if (!contents.equals(expected))
      fail(`${label} contents differ for ${filename}`);
  }
  for (const filename of expectedFiles.keys()) {
    if (!actualFiles.has(filename))
      fail(`${label} is missing file: ${filename}`);
  }
  return actualFiles.size;
}

function verifyArchive(
  expectedFiles,
  archivePath,
  label = "Release ZIP",
  { allowDirectories = true } = {}
) {
  if (!fs.existsSync(archivePath))
    fail(`${label} does not exist: ${archivePath}`);

  const archive = new AdmZip(archivePath);
  const entries = archive.getEntries();
  const packagedFiles = new Set();
  let uncompressedBytes = 0;

  if (entries.length > MAX_ARCHIVE_FILES)
    fail(`Release ZIP contains too many entries: ${entries.length}`);

  for (const entry of entries) {
    requireSafeEntry(entry);
    if (entry.isDirectory) {
      if (!allowDirectories)
        fail(`${label} contains an unexpected directory: ${entry.entryName}`);
      continue;
    }
    if (packagedFiles.has(entry.entryName))
      fail(`Release ZIP contains a duplicate file: ${entry.entryName}`);
    packagedFiles.add(entry.entryName);

    const source = expectedFiles.get(entry.entryName);
    if (!source)
      fail(`${label} contains an unexpected file: ${entry.entryName}`);
    if (entry.header.size !== source.byteLength)
      fail(`${label} size differs for ${entry.entryName}`);

    uncompressedBytes += entry.header.size;
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES)
      fail(`${label} exceeds the uncompressed size limit`);
    if (!entry.getData().equals(source))
      fail(`${label} contents differ for ${entry.entryName}`);
  }

  for (const filename of expectedFiles.keys()) {
    if (!packagedFiles.has(filename))
      fail(`${label} is missing source file: ${filename}`);
  }

  return {
    archivePath,
    bytes: uncompressedBytes,
    verified: packagedFiles.size
  };
}

function verifyTargetZip({
  root = path.join(__dirname, ".."),
  target,
  trackedFiles,
  archivePath,
  quiet = false
} = {}) {
  const config = getTargetConfig({ root, target });
  const expectedFiles = expectedTargetFiles(config, { trackedFiles });
  verifyFileTree(
    expectedFiles,
    config.stageRoot,
    `${target} staging directory`
  );
  const result = verifyArchive(
    expectedFiles,
    archivePath || config.archivePath,
    `${target} release ZIP`,
    { allowDirectories: false }
  );

  if (!quiet)
    console.log(`Verified ${target} release ZIP (${result.verified} files).`);
  return { ...result, target };
}

function verifyZip({
  root = path.join(__dirname, ".."),
  extensionRoot = path.join(root, "chrome-extension"),
  archivePath,
  target,
  quiet = false
} = {}) {
  if (target)
    return verifyTargetZip({ root, target, archivePath, quiet });

  const resolvedArchive = archivePath || selectArchive(root, extensionRoot);
  const result = verifyArchive(
    walkFiles(extensionRoot),
    resolvedArchive
  );
  if (!quiet)
    console.log(`Verified release ZIP (${result.verified} files).`);
  return result;
}

if (require.main === module) {
  try {
    for (const target of parseTargetArguments(process.argv.slice(2)))
      verifyTargetZip({ target });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyTargetZip, verifyZip };
