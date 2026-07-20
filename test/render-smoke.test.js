"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  DYNAMIC_FILES,
  FIXTURE,
  requirePng
} = require("../scripts/smoke-browser.js");

const root = path.join(__dirname, "..");

test("browser smoke fixture covers the supported AMS and font features", () => {
  assert.equal(
    FIXTURE,
    fs.readFileSync(
      path.join(root, "test", "fixtures", "render-smoke.tex"),
      "utf8"
    ).trim()
  );
  for (const command of [
    String.raw`\begin{aligned}`,
    String.raw`\begin{pmatrix}`,
    String.raw`\backepsilon`,
    String.raw`\bigstar`,
    String.raw`\binom`,
    String.raw`\boldsymbol`,
    String.raw`\circledR`,
    String.raw`\int`,
    String.raw`\mathbb`,
    String.raw`\mathcal`,
    String.raw`\mathfrak`,
    String.raw`\operatorname`,
    String.raw`\rightsquigarrow`,
    String.raw`\text`,
    String.raw`\varsubsetneq`,
    String.raw`\vec`,
    String.raw`\yen`
  ])
    assert.ok(FIXTURE.includes(command), command);
  assert.match(FIXTURE, /café.*naïve/s);
  assert.deepEqual([...DYNAMIC_FILES], [
    "arrows.js",
    "calligraphic.js",
    "double-struck.js",
    "fraktur.js",
    "latin.js",
    "math.js",
    "shapes.js",
    "symbols-b-i.js"
  ]);
});

test("browser smoke output validation accepts only bounded PNG images", () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(196, 20);
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

  assert.deepEqual(requirePng(dataUrl), {
    bytes: 24,
    height: 196,
    width: 640
  });
  assert.throws(() => requirePng("data:text/plain;base64,eA=="), /PNG data URL/);
  assert.throws(
    () => requirePng("data:image/png;base64,AAAA"),
    /invalid PNG/
  );
  png.writeUInt32BE(4097, 16);
  assert.throws(
    () => requirePng(`data:image/png;base64,${png.toString("base64")}`),
    /invalid dimensions/
  );
});
