"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const AdmZip = require("adm-zip");
const { buildTarget } = require("../scripts/build-extension.js");
const {
  FIXED_MTIME,
  ZIP_DOS_TIMESTAMP,
  getTargetConfig
} = require("../scripts/extension-targets.js");
const { stageTarget } = require("../scripts/stage-extension.js");
const { verifyTargetZip } = require("../scripts/verify-zip.js");

function writeFile(root, relative, contents = relative) {
  const filename = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex-gmail-package-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  writeFile(root, "package.json", JSON.stringify({ version: "1.2.3" }));

  const sourceFiles = [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "icons/icon.svg",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "icons/icon-128.png",
    "src/background.html",
    "src/background.js",
    "src/chrome-offscreen.html",
    "src/chrome-service-worker.js",
    "src/controller.js",
    "src/shared.js"
  ];
  for (const filename of sourceFiles)
    writeFile(root, `chrome-extension/${filename}`);
  writeFile(
    root,
    "chrome-extension/manifest.json",
    JSON.stringify({ target: "canonical", version: "0.0.0" })
  );

  for (const target of ["firefox", "chrome"]) {
    writeFile(
      root,
      `targets/${target}/manifest.json`,
      `${JSON.stringify({ target, version: "1.2.3" }, null, 2)}\n`
    );
  }
  return root;
}

function sha256(filename) {
  return crypto.createHash("sha256")
    .update(fs.readFileSync(filename))
    .digest("hex");
}

test("staging replaces manifests, cleans stale files, and prunes each target", t => {
  const root = createFixture(t);
  for (const target of ["firefox", "chrome"])
    writeFile(root, `build/${target}/stale.txt`, "stale");

  const firefox = stageTarget({ root, target: "firefox", quiet: true });
  const chrome = stageTarget({ root, target: "chrome", quiet: true });

  for (const config of [firefox, chrome]) {
    assert.equal(fs.existsSync(path.join(config.stageRoot, "stale.txt")), false);
    assert.ok(
      fs.readFileSync(path.join(config.stageRoot, "manifest.json"))
        .equals(fs.readFileSync(config.manifestPath))
    );
    assert.equal(
      fs.statSync(path.join(config.stageRoot, "manifest.json")).mtimeMs,
      FIXED_MTIME.getTime()
    );
    assert.equal(
      fs.statSync(path.join(config.stageRoot, "manifest.json")).mode & 0o777,
      0o644
    );
  }

  assert.equal(
    fs.existsSync(path.join(firefox.stageRoot, "src/background.html")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(firefox.stageRoot, "src/background.js")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(firefox.stageRoot, "src/controller.js")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(firefox.stageRoot, "src/chrome-offscreen.html")),
    false
  );
  assert.equal(
    fs.existsSync(
      path.join(firefox.stageRoot, "src/chrome-service-worker.js")
    ),
    false
  );
  assert.equal(
    fs.existsSync(path.join(firefox.stageRoot, "icons/icon.svg")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(firefox.stageRoot, "icons/icon-16.png")),
    false
  );

  assert.equal(
    fs.existsSync(path.join(chrome.stageRoot, "src/background.html")),
    false
  );
  assert.equal(
    fs.existsSync(path.join(chrome.stageRoot, "src/background.js")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(chrome.stageRoot, "src/controller.js")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(chrome.stageRoot, "src/chrome-offscreen.html")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(chrome.stageRoot, "src/chrome-service-worker.js")),
    true
  );
  assert.equal(
    fs.existsSync(path.join(chrome.stageRoot, "icons/icon.svg")),
    false
  );
  assert.equal(
    fs.existsSync(path.join(chrome.stageRoot, "icons/icon-16.png")),
    true
  );
});

test("target builds produce distinct deterministic ZIPs", t => {
  const root = createFixture(t);
  const first = {};

  for (const target of ["firefox", "chrome"]) {
    const result = buildTarget({ root, target, quiet: true });
    first[target] = sha256(result.archivePath);
    const entries = new AdmZip(result.archivePath).getEntries();
    assert.equal(
      path.basename(result.archivePath),
      `tex-for-gmail-${target}-1.2.3.zip`
    );
    assert.equal(
      JSON.parse(
        entries
          .find(entry => entry.entryName === "manifest.json")
          .getData()
          .toString("utf8")
      ).target,
      target
    );
    assert.deepEqual(
      entries.map(entry => entry.entryName),
      entries.map(entry => entry.entryName).sort()
    );
    for (const entry of entries) {
      assert.equal(entry.header.fileAttr, 0o644, `${target}: ${entry.entryName}`);
      assert.equal(entry.header.method, 0, `${target}: ${entry.entryName}`);
      assert.equal(
        entry.header.timeval,
        ZIP_DOS_TIMESTAMP,
        `${target}: ${entry.entryName}`
      );
    }
    assert.doesNotThrow(() =>
      verifyTargetZip({ root, target, quiet: true })
    );
  }

  assert.notEqual(first.firefox, first.chrome);
  for (const target of ["firefox", "chrome"]) {
    const result = buildTarget({ root, target, quiet: true });
    assert.equal(sha256(result.archivePath), first[target]);
    assert.equal(
      result.archivePath,
      getTargetConfig({ root, target }).archivePath
    );
  }
});

test("target builds exclude untracked, ignored, and sensitive files", t => {
  const root = createFixture(t);
  writeFile(root, ".gitignore", "*.log\n.vscode/\nThumbs.db\n");
  writeFile(root, "chrome-extension/release-debug.log", "debug output\n");
  writeFile(
    root,
    "chrome-extension/.vscode/settings.json",
    "{\"token\":\"secret\"}\n"
  );
  writeFile(root, "chrome-extension/Thumbs.db", "desktop metadata\n");
  writeFile(root, "chrome-extension/reviewer.pem", "private key\n");

  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", [
    "add",
    ".gitignore",
    "package.json",
    "chrome-extension",
    "targets"
  ], { cwd: root });

  for (const target of ["firefox", "chrome"]) {
    const result = buildTarget({ root, target, quiet: true });
    const entries = new Set(
      new AdmZip(result.archivePath).getEntries().map(entry => entry.entryName)
    );
    for (const filename of [
      ".vscode/settings.json",
      "release-debug.log",
      "reviewer.pem",
      "Thumbs.db"
    ]) {
      assert.equal(entries.has(filename), false, `${target}: ${filename}`);
      assert.equal(
        fs.existsSync(path.join(root, "build", target, filename)),
        false,
        `${target} staging: ${filename}`
      );
    }
  }
});
