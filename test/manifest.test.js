"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const root = path.join(__dirname, "..");
const extensionRoot = path.join(root, "chrome-extension");
const MATHJAX_STYLE_HASHES = [
  "'sha256-e5jd7xQq9aULFFMD0eTEu9T1k/67HYr2XT/IFRaDiI0='",
  "'sha256-3ZSLWaOQtqrQ6iNoyQlBEIKBi4iPfnn6qanv5SmcYbg='",
  "'sha256-bgFI+8WNpZyQTg52T+OSNh5Vbm0kkPnj/kOliAUyReE='",
  "'sha256-khzm1f0RgYGW/mmWtJrCL6sPH/UAtSpOwXMy3ZMP/7g='"
];

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
  return [
    ...Object.values(manifest.icons),
    manifest.background.page || manifest.background.service_worker,
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

function storedPngRows(filename) {
  const png = fs.readFileSync(filename);
  const compressed = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT")
      compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }

  const stream = Buffer.concat(compressed);
  assert.deepEqual([...stream.subarray(0, 2)], [0x78, 0x01]);
  const blocks = [];
  let final = false;
  let offset = 2;
  while (!final) {
    const header = stream[offset++];
    final = (header & 1) === 1;
    assert.equal(header & 0xfe, 0);
    const length = stream.readUInt16LE(offset);
    const inverseLength = stream.readUInt16LE(offset + 2);
    offset += 4;
    assert.equal((length ^ inverseLength) & 0xffff, 0xffff);
    blocks.push(stream.subarray(offset, offset + length));
    offset += length;
  }
  assert.equal(offset, stream.length - 4);
  const rows = Buffer.concat(blocks);
  assert.ok(rows.equals(zlib.inflateSync(stream)));
  return rows;
}

test("target manifests keep their shared product fields synchronized", () => {
  for (const key of [
    "author",
    "content_scripts",
    "description",
    "homepage_url",
    "name",
    "short_name",
    "version"
  ])
    assert.deepEqual(chrome[key], firefox[key], `${key} differs`);

  assert.equal(firefox.content_scripts[0].run_at, "document_idle");
  assert.ok(firefox.short_name.length <= 12);
  assert.deepEqual(firefox.content_scripts[0].matches, [
    "https://mail.google.com/*"
  ]);
});

test("target manifests expose only the Gmail compose-toolbar workflow", () => {
  for (const manifest of [chrome, firefox]) {
    assert.equal(manifest.action, undefined);
    assert.equal(manifest.browser_action, undefined);
    assert.equal(manifest.commands, undefined);
    assert.equal(manifest.page_action, undefined);
    assert.equal(manifest.permissions.includes("contextMenus"), false);
  }
  assert.equal(fs.existsSync(path.join(extensionRoot, "popup")), false);
});

test("Firefox target retains reviewed MV2 distribution metadata", () => {
  const gecko = firefox.browser_specific_settings?.gecko;

  assert.equal(firefox.manifest_version, 2);
  assert.equal(gecko?.id, "tex-for-gmail@tomasortega");
  assert.equal(gecko?.strict_min_version, "142.0");
  assert.deepEqual(gecko?.data_collection_permissions?.required, ["none"]);
  assert.deepEqual(firefox.permissions, ["https://mail.google.com/*"]);
  assert.deepEqual(firefox.background, {
    page: "src/background.html",
    persistent: false
  });
});

test("Chrome target uses the minimum MV3 permissions and offscreen host", () => {
  assert.equal(chrome.manifest_version, 3);
  assert.equal(chrome.minimum_chrome_version, "116");
  assert.deepEqual(chrome.permissions, ["offscreen"]);
  assert.deepEqual(chrome.host_permissions, [
    "https://mail.google.com/*"
  ]);
  assert.deepEqual(chrome.background, {
    service_worker: "src/chrome-service-worker.js"
  });
  assert.equal(chrome.incognito, "not_allowed");
  assert.equal(chrome.browser_specific_settings, undefined);
  assert.equal(chrome.browser_action, undefined);
  assert.equal(chrome.action, undefined);
});

test("both targets apply a strict policy without WebAssembly evaluation", () => {
  const expected = {
    "connect-src": ["'none'"],
    "default-src": ["'none'"],
    "img-src": ["'self'", "data:", "blob:"],
    "object-src": ["'none'"],
    "script-src": ["'self'"],
    "style-src": ["'self'", ...MATHJAX_STYLE_HASHES]
  };

  for (const policy of [
    firefox.content_security_policy,
    chrome.content_security_policy.extension_pages
  ]) {
    assert.deepEqual(contentSecurityDirectives(policy), expected);
    assert.doesNotMatch(policy, /wasm|unsafe-eval/i);
  }
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

test("Chrome icons use platform-independent stored DEFLATE", () => {
  for (const size of [16, 32, 48, 128]) {
    const filename = path.join(
      extensionRoot,
      "icons",
      `icon-${size}.png`
    );
    const rows = storedPngRows(filename);
    const stride = size * 4 + 1;
    assert.equal(rows.length, stride * size);
    for (let y = 0; y < size; y++)
      assert.equal(rows[y * stride], 0);
  }
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

test("authored extension scripts do not use dynamic code evaluation", () => {
  const authoredDirectories = ["src"];
  const authoredScripts = authoredDirectories.flatMap(directory =>
    fs.readdirSync(path.join(extensionRoot, directory))
      .filter(filename => filename.endsWith(".js"))
      .map(filename => path.join(extensionRoot, directory, filename))
  );

  for (const filename of authoredScripts) {
    const source = fs.readFileSync(filename, "utf8");
    const relative = path.relative(extensionRoot, filename);
    assert.doesNotMatch(source, /\beval\s*\(/, relative);
    assert.doesNotMatch(
      source,
      /\b(?:new\s+)?Function\s*\(\s*["']/,
      relative
    );
    assert.doesNotMatch(source, /\bWebAssembly\b/, relative);
  }
});
