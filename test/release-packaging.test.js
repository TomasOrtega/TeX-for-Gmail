"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const AdmZip = require("adm-zip");
const { ZIP_DOS_TIMESTAMP } = require("../scripts/extension-targets.js");
const {
  REQUIRED_SOURCE_FILES,
  assertCleanWorktree,
  assertReleaseTag,
  buildRelease,
  buildSourceArchive,
  isAllowedSourceFile,
  listTrackedFiles,
  selectSourceFiles,
  sha256,
  writeChecksums
} = require("../scripts/build-release.js");

function writeFile(root, relative, contents = relative) {
  const filename = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
  return filename;
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex-gmail-release-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  for (const filename of REQUIRED_SOURCE_FILES) {
    const contents = filename === "package.json"
      ? `${JSON.stringify({ version: "1.2.3" }, null, 2)}\n`
      : `contents of ${filename}\n`;
    writeFile(root, filename, contents);
  }
  return root;
}

test("source selection is an explicit safe subset of tracked files", () => {
  const tracked = [
    ...REQUIRED_SOURCE_FILES,
    "test/example.test.js",
    "node_modules/dependency/index.js",
    "docs/reviewer.pem",
    "docs/reviewer-notes.md",
    "dist/release.zip",
    "coverage/lcov.info",
    "chrome-extension/src/background.js",
    "chrome-extension/build/intermediate.js",
    "chrome-extension/debug.log",
    "chrome-extension/Thumbs.db",
    "chrome-extension/.vscode/settings.json",
    "chrome-extension/.env",
    "chrome-extension/.env.production",
    ".github/.env.production",
    ".github/workflows/ci.yml"
  ];

  assert.deepEqual(selectSourceFiles(tracked), [
    ...REQUIRED_SOURCE_FILES,
    ".github/workflows/ci.yml",
    "chrome-extension/src/background.js",
    "docs/reviewer-notes.md",
    "test/example.test.js"
  ].sort());
  assert.equal(isAllowedSourceFile(".github/workflows/ci.yml"), true);
  assert.equal(isAllowedSourceFile("chrome-extension/src/background.js"), true);
  assert.throws(
    () => isAllowedSourceFile("../outside.txt"),
    /unsafe path/
  );
});

test("tracked-file discovery uses NUL-safe Git output", () => {
  const calls = [];
  const filenames = listTrackedFiles({
    root: "/fixture",
    git(root, args) {
      calls.push({ args, root });
      return Buffer.from("targets/firefox/manifest.json\0package.json\0");
    }
  });

  assert.deepEqual(filenames, [
    "package.json",
    "targets/firefox/manifest.json"
  ]);
  assert.deepEqual(calls, [{
    args: ["ls-files", "-z", "--cached"],
    root: "/fixture"
  }]);
});

test("source ZIPs have deterministic entries, metadata, and bytes", t => {
  const root = createFixture(t);
  const trackedFiles = [
    ...REQUIRED_SOURCE_FILES,
    "README.md",
    "docs/reproduction.md"
  ].reverse();
  writeFile(root, "README.md", "read me\n");
  writeFile(root, "docs/reproduction.md", "npm ci\nnpm run build\n");
  writeFile(root, "untracked-secret.env", "TOKEN=secret\n");

  const firstPath = path.join(root, "first.zip");
  const secondPath = path.join(root, "second.zip");
  const first = buildSourceArchive({
    root,
    outputPath: firstPath,
    quiet: true,
    trackedFiles
  });

  for (const filename of trackedFiles) {
    const absolute = path.join(root, ...filename.split("/"));
    fs.chmodSync(absolute, 0o600);
    fs.utimesSync(absolute, new Date(), new Date());
  }
  const second = buildSourceArchive({
    root,
    outputPath: secondPath,
    quiet: true,
    trackedFiles
  });

  assert.equal(sha256(first.archivePath), sha256(second.archivePath));
  assert.deepEqual(first.files, [...first.files].sort());
  assert.equal(first.version, "1.2.3");

  const entries = new AdmZip(firstPath).getEntries();
  assert.deepEqual(
    entries.map(entry => entry.entryName),
    first.files
  );
  for (const entry of entries) {
    assert.equal(entry.header.fileAttr, 0o644);
    assert.equal(entry.header.method, 8);
    assert.equal(entry.header.timeval, ZIP_DOS_TIMESTAMP);
  }
  assert.equal(
    entries.some(entry => entry.entryName === "untracked-secret.env"),
    false
  );
});

test("source archives reject tracked symlinks", t => {
  const root = createFixture(t);
  const target = writeFile(root, "real.txt", "data");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.symlinkSync(target, path.join(root, "docs", "linked.txt"));

  assert.throws(() => buildSourceArchive({
    root,
    outputPath: path.join(root, "source.zip"),
    quiet: true,
    trackedFiles: [...REQUIRED_SOURCE_FILES, "docs/linked.txt"]
  }), /must be a regular file/);
});

test("checksum manifests are sorted and reproducible", t => {
  const root = createFixture(t);
  const beta = writeFile(root, "dist/beta.zip", "beta");
  const alpha = writeFile(root, "dist/alpha.zip", "alpha");
  const outputPath = path.join(root, "dist", "SHA256SUMS");

  const first = writeChecksums({
    root,
    artifacts: [beta, alpha],
    outputPath,
    quiet: true
  });
  const contents = fs.readFileSync(outputPath, "utf8");
  const second = writeChecksums({
    root,
    artifacts: [alpha, beta],
    outputPath,
    quiet: true
  });

  assert.equal(fs.readFileSync(outputPath, "utf8"), contents);
  assert.equal(contents,
    `${sha256(alpha)}  alpha.zip\n${sha256(beta)}  beta.zip\n`);
  assert.deepEqual([...first.hashes], [...second.hashes]);
  assert.throws(() => writeChecksums({
    root,
    artifacts: [alpha, alpha],
    outputPath,
    quiet: true
  }), /duplicate filename/);
});

test("release builds targets before source and checksums", t => {
  const root = createFixture(t);
  const calls = [];
  const result = buildRelease({
    root,
    quiet: true,
    trackedFiles: REQUIRED_SOURCE_FILES,
    buildTargetFn({
      root: fixtureRoot,
      target,
      quiet,
      trackedFiles: targetFiles
    }) {
      calls.push(target);
      assert.equal(fixtureRoot, root);
      assert.equal(quiet, true);
      assert.deepEqual(targetFiles, REQUIRED_SOURCE_FILES);
      const archivePath = writeFile(
        root,
        `dist/tex-for-gmail-${target}-1.2.3.zip`,
        target
      );
      return { archivePath, target };
    }
  });

  assert.deepEqual(calls, ["firefox", "chrome"]);
  assert.equal(
    result.sourceArchivePath,
    path.join(root, "dist", "tex-for-gmail-source-1.2.3.zip")
  );
  assert.equal(result.targetResults.length, 2);
  assert.equal(result.hashes.size, 3);
  assert.deepEqual(
    fs.readFileSync(result.checksumsPath, "utf8").trim().split("\n")
      .map(line => line.split("  ")[1]),
    [
      "tex-for-gmail-chrome-1.2.3.zip",
      "tex-for-gmail-firefox-1.2.3.zip",
      "tex-for-gmail-source-1.2.3.zip"
    ]
  );
});

test("release mode rejects a dirty tree before building", t => {
  const root = createFixture(t);
  let built = false;

  assert.throws(() => buildRelease({
    root,
    requireClean: true,
    quiet: true,
    git(fixtureRoot, args) {
      assert.equal(fixtureRoot, root);
      assert.equal(args[0], "status");
      return Buffer.from(" M package.json\n");
    },
    buildTargetFn() {
      built = true;
      throw new Error("must not build");
    }
  }), /clean Git worktree/);
  assert.equal(built, false);
});

test("clean-worktree validation accepts empty status output", () => {
  assert.doesNotThrow(() => assertCleanWorktree({
    root: "/fixture",
    git: () => Buffer.alloc(0)
  }));
});

test("release mode requires the versioned tag on HEAD", t => {
  const root = createFixture(t);
  const calls = [];

  assert.equal(assertReleaseTag({
    root,
    git(fixtureRoot, args) {
      calls.push(args);
      assert.equal(fixtureRoot, root);
      return Buffer.from("unrelated\nv1.2.3\n");
    }
  }), "v1.2.3");
  assert.deepEqual(calls, [["tag", "--points-at", "HEAD"]]);

  assert.throws(() => assertReleaseTag({
    root,
    git: () => Buffer.from("v1.2.2\n")
  }), /requires Git tag v1\.2\.3/);
});

test("release and Firefox reproduction scripts enforce their gates", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  );

  assert.equal(
    packageJson.scripts["release:artifacts"],
    "node scripts/build-release.js --release"
  );
  const reproduce = packageJson.scripts["reproduce:firefox"];
  const coverage = packageJson.scripts["test:coverage"];
  assert.match(
    coverage,
    /--test-coverage-include="chrome-extension\/src\/\*\*\/\*\.js"/
  );
  assert.match(coverage, /--test-coverage-lines=100/);
  assert.match(reproduce, /vendor:mathjax:check/);
  assert.match(reproduce, /test:coverage/);
  assert.match(reproduce, /lint:firefox/);
  assert.match(reproduce, /build:firefox/);
  assert.match(reproduce, /verify:zip:firefox/);
  assert.doesNotMatch(reproduce, /smoke:browser|npm run audit/);
});

test("release mode validates before building artifacts", t => {
  const root = createFixture(t);
  let built = false;

  assert.throws(() => buildRelease({
    root,
    requireClean: true,
    quiet: true,
    trackedFiles: REQUIRED_SOURCE_FILES,
    git(_fixtureRoot, args) {
      if (args[0] === "status")
        return Buffer.alloc(0);
      if (args[0] === "tag")
        return Buffer.from("v1.2.3\n");
      throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    },
    validateFn() {
      throw new Error("validation failed");
    },
    buildTargetFn() {
      built = true;
      throw new Error("must not build");
    }
  }), /validation failed/);
  assert.equal(built, false);
});
