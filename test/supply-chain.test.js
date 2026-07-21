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

test("production packages exclude the legacy rendering toolchain", () => {
  const prohibitedPackages = ["browserfs", "mupdf"];
  const installedPaths = Object.keys(packageLock.packages || {});
  for (const packageName of prohibitedPackages)
    assert.equal(
      installedPaths.some(entry =>
        entry === `node_modules/${packageName}` ||
        entry.endsWith(`/node_modules/${packageName}`)
      ),
      false,
      `${packageName} remains in the dependency tree`
    );

  const prohibitedPaths = [
    "chrome-extension/resources/browserfs",
    "chrome-extension/resources/data",
    "chrome-extension/resources/mupdf",
    "chrome-extension/resources/scripts/browserfs.min.js",
    "chrome-extension/resources/scripts/pdflatex.js",
    "chrome-extension/resources/texlive",
    "chrome-extension/resources/wasm",
    "chrome-extension/src/mupdfworker.js",
    "chrome-extension/src/pdftexworker.js",
    "scripts/smoke-mupdf.mjs",
    "scripts/trace-tex-resources.js",
    "scripts/vendor-browserfs.js",
    "scripts/vendor-mupdf.js",
    "scripts/vendor-texlive.js",
    "wasm"
  ];
  for (const relativePath of prohibitedPaths)
    assert.equal(
      fs.existsSync(path.join(root, relativePath)),
      false,
      `${relativePath} remains in the source package`
    );

  const extensionFiles = fs.readdirSync(
    path.join(root, "chrome-extension"),
    { recursive: true }
  );
  assert.equal(
    extensionFiles.some(filename => filename.endsWith(".wasm")),
    false,
    "a WebAssembly binary remains in the extension package"
  );
});

test("packaged MathJax files exactly match pinned npm artifacts", () => {
  const expectedPackages = new Map([
    [
      "@mathjax/src@4.1.3",
      "sha512-rIrWquuBSoJuoMBdC/1qD+AUHTorlccPicoVy6P2" +
        "xbUgnuDBpCcpbHtOAsB8L3hdCHtNBg92lF8e3Fz+pkcQbw=="
    ],
    [
      "@mathjax/mathjax-newcm-font@4.1.3",
      "sha512-gzAB3dFHilHX1l5x2xUqRL+1jDQt3Fyza1DkEMVXWC4E" +
        "8SvsGdlgEza47HYi2WhVcgfkvf4zgUGzuhbq3Pjlew=="
    ]
  ]);
  const mathJaxComponents = artifactLock.components.filter(component =>
    component.npmPackage?.startsWith("@mathjax/")
  );

  assert.deepEqual(
    new Set(mathJaxComponents.map(component => component.npmPackage)),
    new Set(expectedPackages.keys())
  );
  for (const component of mathJaxComponents) {
    const expectedIntegrity = expectedPackages.get(component.npmPackage);
    const separator = component.npmPackage.lastIndexOf("@");
    const packageName = component.npmPackage.slice(0, separator);
    const version = component.npmPackage.slice(separator + 1);
    const locked = packageLock.packages[`node_modules/${packageName}`];

    assert.equal(component.version, version);
    assert.equal(component.license, "Apache-2.0");
    assert.equal(component.npmIntegrity, expectedIntegrity);
    assert.equal(component.source.endsWith(`/tree/${version}`), true);
    assert.match(component.provenance, /copies exact .*without modification/);
    assert.equal(locked.version, version);
    assert.equal(locked.integrity, expectedIntegrity);
    assert.equal(locked.license, "Apache-2.0");
  }

  assert.equal(packageLock.packages[""].devDependencies["@mathjax/src"], "4.1.3");
  const { check, files } = require("../scripts/vendor-mathjax.js");
  assert.equal(check(), files.length);
  const { MathJaxNewcmFont } = require(
    "@mathjax/mathjax-newcm-font/cjs/svg.js"
  );
  const upstreamDynamicFiles = Object.values(MathJaxNewcmFont.dynamicFiles)
    .map(({ file }) => `mathjax-newcm-font/svg/dynamic/${file}.js`)
    .sort();
  const vendoredDynamicFiles = files
    .map(file => file.destination)
    .filter(destination => destination.includes("/dynamic/"))
    .sort();

  assert.deepEqual(vendoredDynamicFiles, upstreamDynamicFiles);
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

test("vendored artifacts pass the repository integrity check", () => {
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
