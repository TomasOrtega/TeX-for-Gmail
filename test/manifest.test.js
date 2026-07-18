"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const root = path.join(__dirname, "..");
const extensionRoot = path.join(root, "chrome-extension");

function readJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(root, filename), "utf8"));
}

const firefox = readJson("targets/firefox/manifest.json");
const chrome = readJson("targets/chrome/manifest.json");

function contentSecurityDirectives(policy) {
  return Object.fromEntries(
    policy
      .split(";")
      .map(directive => directive.trim())
      .filter(Boolean)
      .map(directive => {
        const [name, ...sources] = directive.split(/\s+/);
        return [name, sources];
      })
  );
}

function referencedFiles(manifest) {
  const action = manifest.action || manifest.browser_action;
  return [
    ...Object.values(manifest.icons),
    manifest.background.page || manifest.background.service_worker,
    action.default_popup,
    ...(typeof action.default_icon === "string"
      ? [action.default_icon]
      : Object.values(action.default_icon)),
    ...manifest.content_scripts.flatMap(content => [
      ...(content.css || []),
      ...(content.js || [])
    ])
  ];
}

function pngMetadata(filename) {
  const png = fs.readFileSync(filename);
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10]
  );
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  return {
    colorType: png[25],
    height: png.readUInt32BE(20),
    width: png.readUInt32BE(16)
  };
}

function pngAlphaBounds(filename) {
  const png = fs.readFileSync(filename);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const compressed = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT")
      compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rows = zlib.inflateSync(Buffer.concat(compressed));
  const stride = width * 4 + 1;
  assert.equal(rows.length, stride * height);

  const bounds = {
    maxX: -1,
    maxY: -1,
    minX: width,
    minY: height
  };
  for (let y = 0; y < height; y++) {
    assert.equal(rows[y * stride], 0);
    for (let x = 0; x < width; x++) {
      const alpha = rows[y * stride + 1 + x * 4 + 3];
      if (alpha === 0)
        continue;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  }
  return bounds;
}

test("target manifests keep their shared product fields synchronized", () => {
  for (const key of [
    "author",
    "commands",
    "content_scripts",
    "description",
    "homepage_url",
    "name",
    "short_name",
    "version"
  ])
    assert.deepEqual(chrome[key], firefox[key], `${key} differs`);

  assert.equal(firefox.content_scripts[0].run_at, "document_idle");
  assert.deepEqual(firefox.content_scripts[0].matches, [
    "https://mail.google.com/*"
  ]);
});

test("Firefox target retains reviewed MV2 distribution metadata", () => {
  const gecko = firefox.browser_specific_settings?.gecko;

  assert.equal(firefox.manifest_version, 2);
  assert.match(gecko?.id ?? "", /^[^@]+@[^@]+$/);
  assert.equal(gecko?.strict_min_version, "142.0");
  assert.deepEqual(gecko?.data_collection_permissions?.required, ["none"]);
  assert.deepEqual(firefox.permissions, [
    "contextMenus",
    "https://mail.google.com/*"
  ]);
  assert.deepEqual(firefox.background, {
    page: "src/background.html",
    persistent: false
  });
});

test("Chrome target uses the minimum MV3 permissions and offscreen host", () => {
  assert.equal(chrome.manifest_version, 3);
  assert.equal(chrome.minimum_chrome_version, "116");
  assert.deepEqual(chrome.permissions, ["contextMenus", "offscreen"]);
  assert.deepEqual(chrome.host_permissions, [
    "https://mail.google.com/*"
  ]);
  assert.deepEqual(chrome.background, {
    service_worker: "src/chrome-service-worker.js"
  });
  assert.equal(chrome.incognito, "not_allowed");
  assert.equal(chrome.browser_specific_settings, undefined);
  assert.equal(chrome.browser_action, undefined);
  assert.equal(typeof chrome.action, "object");
});

test("both targets apply a strict policy that permits packaged WebAssembly", () => {
  const expected = {
    "connect-src": ["'self'"],
    "default-src": ["'none'"],
    "img-src": ["'self'", "data:"],
    "object-src": ["'none'"],
    "script-src": ["'self'", "'wasm-unsafe-eval'"],
    "style-src": ["'self'"],
    "worker-src": ["'self'"]
  };

  assert.deepEqual(
    contentSecurityDirectives(firefox.content_security_policy),
    expected
  );
  assert.deepEqual(
    contentSecurityDirectives(
      chrome.content_security_policy.extension_pages
    ),
    expected
  );
});

test("all manifest resources exist in the shared source tree", () => {
  for (const [target, manifest] of Object.entries({ chrome, firefox })) {
    for (const filename of referencedFiles(manifest)) {
      assert.equal(
        fs.existsSync(path.join(extensionRoot, filename)),
        true,
        `${target} manifest resource is missing: ${filename}`
      );
    }
  }

  assert.equal(
    fs.existsSync(path.join(extensionRoot, "src", "chrome-offscreen.html")),
    true
  );
});

test("Chrome icons are RGBA PNGs at their declared dimensions", () => {
  for (const size of [16, 32, 48, 128]) {
    assert.deepEqual(
      pngMetadata(path.join(
        extensionRoot,
        "icons",
        `icon-${size}.png`
      )),
      {
        colorType: 6,
        height: size,
        width: size
      }
    );
  }

  assert.deepEqual(
    pngAlphaBounds(path.join(
      extensionRoot,
      "icons",
      "icon-128.png"
    )),
    {
      maxX: 111,
      maxY: 111,
      minX: 16,
      minY: 16
    }
  );
});

test("platform hosts load only their required shared scripts", () => {
  const firefoxBackground = fs.readFileSync(
    path.join(extensionRoot, "src", "background.html"),
    "utf8"
  );
  const chromeOffscreen = fs.readFileSync(
    path.join(extensionRoot, "src", "chrome-offscreen.html"),
    "utf8"
  );
  const chromeWorker = fs.readFileSync(
    path.join(extensionRoot, "src", "chrome-service-worker.js"),
    "utf8"
  );

  assert.match(firefoxBackground, /background\.js/);
  assert.match(firefoxBackground, /controller\.js/);
  assert.doesNotMatch(firefoxBackground, /chrome-service-worker\.js/);
  assert.match(chromeOffscreen, /background\.js/);
  assert.doesNotMatch(chromeOffscreen, /controller\.js/);
  assert.match(chromeWorker, /importScripts\("controller\.js"\)/);
});

test("packaged scripts do not use dynamic code evaluation", () => {
  const browserFs = fs.readFileSync(
    path.join(extensionRoot, "resources", "scripts", "browserfs.min.js"),
    "utf8"
  );

  assert.doesNotMatch(browserFs, /\beval\s*\(/);
  assert.doesNotMatch(browserFs, /\bFunction\s*\(\s*["']/);
});
