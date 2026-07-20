#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const AdmZip = require("adm-zip");
const { buildTarget } = require("./build-extension.js");
const {
  TARGETS,
  ZIP_DOS_TIMESTAMP
} = require("./extension-targets.js");
const {
  compareNames,
  isSafeReleaseFile,
  listTrackedFiles,
  normalizeRepositoryPath,
  runGit
} = require("./release-files.js");

const ZIP_STORED_METHOD = 0;
const SOURCE_FILES = Object.freeze(new Set([
  ".gitattributes",
  ".gitignore",
  "AUTHORS",
  "CONTRIBUTING.md",
  "LICENSE",
  "PRIVACY.md",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "artifacts.lock.json",
  "package-lock.json",
  "package.json"
]));
const SOURCE_DIRECTORIES = Object.freeze([
  ".github/",
  "chrome-extension/",
  "docs/",
  "scripts/",
  "targets/",
  "test/"
]);
const REQUIRED_SOURCE_FILES = Object.freeze([
  ".github/badges/coverage.svg",
  "LICENSE",
  "PRIVACY.md",
  "README.md",
  "SECURITY.md",
  "artifacts.lock.json",
  "chrome-extension/LICENSE",
  "chrome-extension/THIRD_PARTY_NOTICES.md",
  "docs/AMO_REVIEW.md",
  "docs/CWS_REVIEW.md",
  "docs/RELEASING.md",
  "package-lock.json",
  "package.json",
  "scripts/build-extension.js",
  "scripts/build-release.js",
  "scripts/coverage-badge.js",
  "scripts/extension-targets.js",
  "scripts/generate-icons.js",
  "scripts/lint-extension.js",
  "scripts/release-files.js",
  "scripts/smoke-browser.js",
  "scripts/stage-extension.js",
  "scripts/update-artifact-lock.js",
  "scripts/vendor-mathjax.js",
  "scripts/verify-artifacts.js",
  "scripts/verify-release.js",
  "scripts/verify-zip.js",
  "targets/chrome/manifest.json",
  "targets/firefox/manifest.json"
]);
function fail(message) {
  throw new Error(message);
}

function isAllowedSourceFile(filename) {
  const normalized = normalizeRepositoryPath(filename);
  if (!isSafeReleaseFile(normalized))
    return false;
  return SOURCE_FILES.has(normalized) ||
    SOURCE_DIRECTORIES.some(directory => normalized.startsWith(directory));
}

function selectSourceFiles(trackedFiles) {
  const selected = [...new Set(
    trackedFiles.map(normalizeRepositoryPath).filter(isAllowedSourceFile)
  )].sort(compareNames);
  const selectedSet = new Set(selected);
  const missing = REQUIRED_SOURCE_FILES.filter(
    filename => !selectedSet.has(filename)
  );
  if (missing.length > 0)
    fail(`Source archive is missing required tracked files: ${missing.join(", ")}`);
  return selected;
}

function readVersion(root) {
  let packageJson;
  try {
    packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8")
    );
  } catch (error) {
    fail(`Cannot read package.json: ${error.message}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(packageJson.version || ""))
    fail("package.json must use a three-part numeric release version");
  return packageJson.version;
}

function addSourceEntry(archive, root, filename) {
  const absolute = path.join(root, ...filename.split("/"));
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    fail(`Cannot inspect tracked source file ${filename}: ${error.message}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile())
    fail(`Tracked source path must be a regular file: ${filename}`);

  const entry = archive.addFile(
    filename,
    fs.readFileSync(absolute),
    "",
    0o644
  );
  entry.header.timeval = ZIP_DOS_TIMESTAMP;
  entry.header.method = ZIP_STORED_METHOD;
}

function buildSourceArchive({
  root = path.join(__dirname, ".."),
  outputPath,
  trackedFiles,
  git = runGit,
  quiet = false
} = {}) {
  const version = readVersion(root);
  const archivePath = outputPath || path.join(
    root,
    "dist",
    `tex-for-gmail-source-${version}.zip`
  );
  const selected = selectSourceFiles(
    trackedFiles === undefined ? listTrackedFiles({ root, git }) : trackedFiles
  );
  const archive = new AdmZip({ noSort: true });

  for (const filename of selected)
    addSourceEntry(archive, root, filename);

  fs.mkdirSync(path.dirname(archivePath), { mode: 0o755, recursive: true });
  fs.writeFileSync(archivePath, archive.toBuffer(), { mode: 0o644 });
  fs.chmodSync(archivePath, 0o644);

  if (!quiet) {
    console.log(
      `Built ${path.relative(root, archivePath)} ` +
      `(${selected.length} files, ${fs.statSync(archivePath).size} bytes).`
    );
  }
  return {
    archivePath,
    files: selected,
    version
  };
}

function sha256(filename) {
  return crypto.createHash("sha256")
    .update(fs.readFileSync(filename))
    .digest("hex");
}

function writeChecksums({
  root = path.join(__dirname, ".."),
  artifacts,
  outputPath = path.join(root, "dist", "SHA256SUMS"),
  quiet = false
}) {
  if (!Array.isArray(artifacts) || artifacts.length === 0)
    fail("At least one release artifact is required");

  const byName = new Map();
  for (const filename of artifacts) {
    const basename = path.basename(filename);
    if (byName.has(basename))
      fail(`Release artifacts have a duplicate filename: ${basename}`);
    const stats = fs.lstatSync(filename);
    if (stats.isSymbolicLink() || !stats.isFile())
      fail(`Release artifact must be a regular file: ${filename}`);
    byName.set(basename, filename);
  }

  const hashes = new Map();
  const contents = [...byName].sort(([left], [right]) =>
    compareNames(left, right)
  ).map(([basename, filename]) => {
    const digest = sha256(filename);
    hashes.set(basename, digest);
    return `${digest}  ${basename}\n`;
  }).join("");

  fs.mkdirSync(path.dirname(outputPath), { mode: 0o755, recursive: true });
  fs.writeFileSync(outputPath, contents, { mode: 0o644 });
  fs.chmodSync(outputPath, 0o644);

  if (!quiet)
    console.log(`Wrote ${path.relative(root, outputPath)}.`);
  return { hashes, outputPath };
}

function assertCleanWorktree({
  root = path.join(__dirname, ".."),
  git = runGit
} = {}) {
  const output = git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  ]).toString("utf8");
  if (output.length > 0)
    fail("Release mode requires a clean Git worktree");
}

function assertReleaseTag({
  root = path.join(__dirname, ".."),
  git = runGit
} = {}) {
  const expected = `v${readVersion(root)}`;
  const tags = git(root, ["tag", "--points-at", "HEAD"])
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  if (!tags.includes(expected))
    fail(`Release mode requires Git tag ${expected} on HEAD`);
  return expected;
}

function runValidation({
  root = path.join(__dirname, "..")
} = {}) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(executable, ["run", "validate"], {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
}

function buildRelease({
  root = path.join(__dirname, ".."),
  requireClean = false,
  quiet = false,
  trackedFiles,
  git = runGit,
  buildTargetFn = buildTarget,
  validateFn = runValidation
} = {}) {
  if (requireClean) {
    assertCleanWorktree({ root, git });
    assertReleaseTag({ root, git });
    validateFn({ root });
    assertCleanWorktree({ root, git });
  }

  const releaseFiles = trackedFiles === undefined
    ? listTrackedFiles({ root, git })
    : trackedFiles;
  const targetResults = TARGETS.map(target =>
    buildTargetFn({
      root,
      target,
      quiet: true,
      trackedFiles: releaseFiles
    })
  );
  const source = buildSourceArchive({
    root,
    trackedFiles: releaseFiles,
    git,
    quiet: true
  });
  const artifactPaths = [
    ...targetResults.map(result => result.archivePath),
    source.archivePath
  ];
  const checksums = writeChecksums({
    root,
    artifacts: artifactPaths,
    quiet: true
  });

  if (!quiet) {
    console.log(
      `Built ${artifactPaths.length} release archives and ` +
      `${path.relative(root, checksums.outputPath)}.`
    );
  }
  return {
    checksumsPath: checksums.outputPath,
    hashes: checksums.hashes,
    sourceArchivePath: source.archivePath,
    targetResults
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.some(argument => argument !== "--release"))
    fail(`Usage: ${path.basename(process.argv[1])} [--release]`);
  buildRelease({ requireClean: argv.includes("--release") });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  REQUIRED_SOURCE_FILES,
  SOURCE_DIRECTORIES,
  SOURCE_FILES,
  assertCleanWorktree,
  assertReleaseTag,
  buildRelease,
  buildSourceArchive,
  isAllowedSourceFile,
  listTrackedFiles,
  main,
  runValidation,
  selectSourceFiles,
  sha256,
  writeChecksums
};
