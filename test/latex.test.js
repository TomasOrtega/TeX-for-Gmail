"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const latex = require(
  path.join("..", "chrome-extension", "src", "latex.js")
);

test("normalizeInput accepts common inline and display delimiters", () => {
  assert.deepEqual(latex.normalizeInput("  $x^2$  "), {
    source: "x^2",
    display: false,
    original: "$x^2$"
  });
  assert.deepEqual(latex.normalizeInput("$$x^2$$"), {
    source: "x^2",
    display: true,
    original: "$$x^2$$"
  });
  assert.deepEqual(latex.normalizeInput(String.raw`\(\alpha\)`), {
    source: String.raw`\alpha`,
    display: false,
    original: String.raw`\(\alpha\)`
  });
  assert.deepEqual(latex.normalizeInput(String.raw`\[\alpha\]`), {
    source: String.raw`\alpha`,
    display: true,
    original: String.raw`\[\alpha\]`
  });
});

test("normalizeInput treats undelimited input as inline math", () => {
  assert.deepEqual(latex.normalizeInput(String.raw`\frac{1}{2}`), {
    source: String.raw`\frac{1}{2}`,
    display: false,
    original: String.raw`\frac{1}{2}`
  });
});

test("normalizeInput rejects empty input", () => {
  assert.throws(() => latex.normalizeInput("  "), /Enter some LaTeX/);
});

test("buildDocument creates a cropped self-contained LaTeX document", () => {
  const source = latex.buildDocument({
    source: String.raw`x^2`,
    display: true
  });

  assert.match(source, /\\documentclass\[preview,border=2pt\]\{standalone\}/);
  assert.match(source, /\\usepackage\{amsmath,amssymb\}/);
  assert.match(source, /\\\[x\^2\\\]/);
  assert.match(source, /\\end\{document\}/);
});
