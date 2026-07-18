"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const artifactLock = JSON.parse(
  fs.readFileSync(path.join(root, "artifacts.lock.json"), "utf8")
);
const packageLock = JSON.parse(
  fs.readFileSync(path.join(root, "package-lock.json"), "utf8")
);

test("prohibited AsyncAPI generator packages are absent", () => {
  const prohibited = [
    "@asyncapi/generator",
    "@asyncapi/generator-components",
    "@asyncapi/generator-helpers",
    "@asyncapi/specs"
  ];
  const installedPaths = Object.keys(packageLock.packages || {});

  for (const packageName of prohibited)
    assert.equal(
      installedPaths.some(entry =>
        entry === `node_modules/${packageName}` ||
        entry.endsWith(`/node_modules/${packageName}`)
      ),
      false,
      `${packageName} is installed`
    );
});

test("Firefox tooling uses the fixed, compatible ZIP parser", t => {
  const admZip = packageLock.packages["node_modules/adm-zip"];
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "tex-gmail-zip-source-"));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "tex-gmail-zip-target-"));

  t.after(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });

  assert.equal(admZip?.version, "0.6.0");
  fs.writeFileSync(path.join(source, "profile.txt"), "safe");

  const AdmZip = require("adm-zip");
  const archive = new AdmZip();
  archive.addLocalFolder(source);
  new AdmZip(archive.toBuffer()).extractAllTo(target, true);

  assert.equal(fs.readFileSync(path.join(target, "profile.txt"), "utf8"), "safe");
});

test("runtime TeX data is packaged and records its source revision", () => {
  const source = fs.readFileSync(
    path.join(root, "chrome-extension", "src", "pdftexworker.js"),
    "utf8"
  );
  const texLive = artifactLock.sourceResources.texLive;

  assert.match(texLive.commit, /^[0-9a-f]{40}$/);
  assert.ok(source.includes(
    'const TEXLIVE_BASE_URL = "../resources/texlive"'
  ));
  assert.ok(source.includes("baseUrl: TEXLIVE_BASE_URL"));
  assert.doesNotMatch(source, /cdn\.jsdelivr\.net|CacheFS|storeName:\s*`texlive/);
});

test("generated artifacts pass the repository integrity check", () => {
  const { verifyArtifacts } = require("../scripts/verify-artifacts.js");

  assert.doesNotThrow(() => verifyArtifacts({ root, quiet: true }));
});

test("release metadata and packaged files pass validation", () => {
  const { verifyRelease } = require("../scripts/verify-release.js");

  assert.doesNotThrow(() => verifyRelease({ root, quiet: true }));
});

test("release ZIP must exactly match the extension source tree", t => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tex-gmail-zip-"));
  const extensionRoot = path.join(fixtureRoot, "chrome-extension");
  const archivePath = path.join(fixtureRoot, "extension.zip");
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  fs.mkdirSync(path.join(extensionRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, "manifest.json"),
    JSON.stringify({ name: "Fixture", version: "1.0.0" })
  );
  fs.writeFileSync(path.join(extensionRoot, "src", "worker.js"), "\"use strict\";\n");

  const AdmZip = require("adm-zip");
  const archive = new AdmZip();
  archive.addLocalFolder(extensionRoot);
  archive.writeZip(archivePath);

  const { verifyZip } = require("../scripts/verify-zip.js");
  assert.equal(
    verifyZip({ archivePath, extensionRoot, quiet: true }).verified,
    2
  );

  archive.addFile("unexpected.txt", Buffer.from("unexpected"));
  archive.writeZip(archivePath);
  assert.throws(
    () => verifyZip({ archivePath, extensionRoot, quiet: true }),
    /unexpected file/
  );
});
