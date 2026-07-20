#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  TARGETS,
  expectedTargetFiles,
  getTargetConfig
} = require("./extension-targets.js");
const { verifyArtifacts } = require("./verify-artifacts.js");

function fail(message) {
  throw new Error(message);
}

function requireExactArray(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${label} differs from the reviewed release set`);
}

function requireComposeToolbarOnly(manifest, target) {
  if (manifest.action ||
      manifest.browser_action ||
      manifest.commands ||
      manifest.page_action) {
    fail(`${target} manifest must not expose legacy extension UI`);
  }
}

function manifestResourcePaths(manifest) {
  const paths = new Set();
  const add = value => {
    if (typeof value === "string")
      paths.add(value);
  };
  const addIcons = value => {
    if (typeof value === "string") {
      add(value);
      return;
    }
    for (const filename of Object.values(value || {}))
      add(filename);
  };

  addIcons(manifest.icons);
  add(manifest.background?.page);
  add(manifest.background?.service_worker);
  for (const filename of manifest.background?.scripts || [])
    add(filename);
  for (const contentScript of manifest.content_scripts || []) {
    for (const filename of [
      ...(contentScript.css || []),
      ...(contentScript.js || [])
    ])
      add(filename);
  }
  add(manifest.devtools_page);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  for (const filename of Object.values(manifest.chrome_url_overrides || {}))
    add(filename);
  return paths;
}

function verifyTargetManifest(config) {
  const expectedCsp =
    "default-src 'none'; script-src 'self'; connect-src 'none'; " +
    "img-src 'self' data: blob:; style-src 'self' " +
    "'sha256-e5jd7xQq9aULFFMD0eTEu9T1k/67HYr2XT/IFRaDiI0=' " +
    "'sha256-3ZSLWaOQtqrQ6iNoyQlBEIKBi4iPfnn6qanv5SmcYbg=' " +
    "'sha256-bgFI+8WNpZyQTg52T+OSNh5Vbm0kkPnj/kOliAUyReE=' " +
    "'sha256-khzm1f0RgYGW/mmWtJrCL6sPH/UAtSpOwXMy3ZMP/7g='; " +
    "object-src 'none'";
  const { manifest, target } = config;
  requireComposeToolbarOnly(manifest, target);

  if (target === "firefox") {
    if (manifest.manifest_version !== 2)
      fail("Firefox target must use Manifest V2");
    const gecko = manifest.browser_specific_settings?.gecko;
    if (!gecko?.id || !gecko?.strict_min_version)
      fail("Firefox distribution metadata is incomplete");
    requireExactArray(
      gecko.data_collection_permissions?.required,
      ["none"],
      "Firefox data-collection declaration"
    );
    requireExactArray(
      manifest.permissions,
      ["https://mail.google.com/*"],
      "Firefox permissions"
    );
    if (manifest.host_permissions ||
        manifest.optional_permissions ||
        manifest.optional_host_permissions)
      fail("Firefox manifest contains unreviewed permission fields");
    if (manifest.background?.page !== "src/background.html" ||
        manifest.background?.persistent !== false)
      fail("Firefox must use the non-persistent background page");
    if (manifest.content_security_policy !== expectedCsp)
      fail("Firefox content security policy differs from the release policy");
    return;
  }

  if (manifest.manifest_version !== 3)
    fail("Chrome target must use Manifest V3");
  if (manifest.minimum_chrome_version !== "116")
    fail("Chrome minimum version must remain 116");
  if (manifest.incognito !== "not_allowed")
    fail("Chrome incognito access must remain disabled");
  requireExactArray(
    manifest.permissions,
    ["offscreen"],
    "Chrome permissions"
  );
  requireExactArray(
    manifest.host_permissions,
    ["https://mail.google.com/*"],
    "Chrome host permissions"
  );
  if (manifest.optional_permissions ||
      manifest.optional_host_permissions ||
      manifest.browser_specific_settings)
    fail("Chrome manifest contains unreviewed browser or permission fields");
  if (manifest.background?.service_worker !== "src/chrome-service-worker.js")
    fail("Chrome must use the reviewed service worker");
  if (manifest.content_security_policy?.extension_pages !== expectedCsp)
    fail("Chrome content security policy differs from the release policy");
}

function verifyRelease({
  root = path.join(__dirname, ".."),
  quiet = false
} = {}) {
  const extensionRoot = path.join(root, "chrome-extension");
  const requiredFiles = [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md"
  ];
  for (const filename of requiredFiles) {
    if (!fs.existsSync(path.join(extensionRoot, filename)))
      fail(`Extension package is missing ${filename}`);
  }
  const notices = fs.readFileSync(
    path.join(extensionRoot, "THIRD_PARTY_NOTICES.md"),
    "utf8"
  );
  if (/github\.com\/[^)\s]+\/blob\/(?:main|master)\//.test(notices))
    fail("Third-party notices must not link mutable default-branch files");
  if (!fs.readFileSync(path.join(root, "LICENSE"))
    .equals(fs.readFileSync(path.join(extensionRoot, "LICENSE"))))
    fail("Packaged LICENSE differs from the repository license");

  const forbidden = [
    /(^|\/)\.DS_Store$/,
    /(^|\/)\.env(?:\.|$)/,
    /(^|\/)hot-reload\.js$/,
    /\.(?:key|pem|p12)$/,
    /\.js\.map$/,
    /(?:^|\/)(?:browserfs|mupdf|texlive|wasm)(?:\/|$)/,
    /(?:^|\/)(?:mupdfworker|pdftexworker|pdflatex)(?:\.|$)/
  ];
  const maxPackageFiles = 40;
  const maxPackageBytes = 13 * 256 * 1024;
  const targetResults = [];
  for (const target of TARGETS) {
    const config = getTargetConfig({ root, target });
    if (fs.lstatSync(config.manifestPath).isSymbolicLink())
      fail(`${target} target manifest must not be a symlink`);
    verifyTargetManifest(config);
    const files = expectedTargetFiles(config);
    const requiredRuntimeFiles = target === "firefox"
      ? ["src/background.html", "src/background.js", "src/controller.js"]
      : [
        "src/background.js",
        "src/chrome-offscreen.html",
        "src/chrome-service-worker.js",
        "src/controller.js"
      ];
    for (const filename of requiredRuntimeFiles) {
      if (!files.has(filename))
        fail(`${target} package is missing ${filename}`);
    }
    for (const filename of manifestResourcePaths(config.manifest)) {
      if (filename.includes("\\") ||
          filename.startsWith("/") ||
          filename.split("/").includes(".."))
        fail(`${target} manifest contains an unsafe resource path: ${filename}`);
      if (!files.has(filename))
        fail(`${target} manifest references a missing file: ${filename}`);
    }
    for (const filename of files.keys()) {
      if (forbidden.some(pattern => pattern.test(filename)))
        fail(`${target} package contains forbidden release file: ${filename}`);
    }
    const bytes = [...files.values()]
      .reduce((total, contents) => total + contents.byteLength, 0);
    if (files.size > maxPackageFiles)
      fail(`${target} package exceeds the ${maxPackageFiles}-file budget`);
    if (bytes > maxPackageBytes)
      fail(`${target} package exceeds the ${maxPackageBytes}-byte budget`);
    targetResults.push({ bytes, files: files.size, target });
  }

  const result = verifyArtifacts({ root, quiet: true });
  if (!quiet)
    console.log(
      `Release validation passed for ${TARGETS.join(" and ")} ` +
      `(${result.verified} artifacts).`
    );
  return { ...result, targets: targetResults };
}

if (require.main === module) {
  try {
    verifyRelease();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyRelease };
