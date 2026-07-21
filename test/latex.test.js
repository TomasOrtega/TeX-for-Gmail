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
  assert.throws(() => latex.normalizeInput(null), /Enter some LaTeX/);
  assert.throws(() => latex.normalizeInput("$ $"), /Enter some LaTeX/);
  assert.throws(() => latex.normalizeInput("$$  $$"), /Enter some LaTeX/);
  assert.throws(() => latex.normalizeInput(String.raw`\( \)`), /Enter some LaTeX/);
  assert.throws(() => latex.normalizeInput(String.raw`\[ \]`), /Enter some LaTeX/);
});

test("normalizeInput enforces its source bound and display override", () => {
  assert.throws(
    () => latex.normalizeInput("x".repeat(latex.MAX_SOURCE_LENGTH + 1)),
    /too long/i
  );
  assert.deepEqual(latex.normalizeInput("$x$", true), {
    source: "x",
    display: true,
    original: "$x$"
  });
  assert.deepEqual(latex.normalizeInput("$$x$$", false), {
    source: "x",
    display: false,
    original: "$$x$$"
  });
});

test("findDelimitedMath locates only complete, unescaped math expressions", () => {
  const input = String.raw`Cost \$5; $x^2$ and \[\frac{1}{2}\], then \(y\).`;

  assert.deepEqual(latex.findDelimitedMath(input), [
    {
      end: 15,
      start: 10,
      text: "$x^2$"
    },
    {
      end: 35,
      start: 20,
      text: String.raw`\[\frac{1}{2}\]`
    },
    {
      end: 47,
      start: 42,
      text: String.raw`\(y\)`
    }
  ]);
  assert.deepEqual(latex.findDelimitedMath("$x + y"), []);
  assert.deepEqual(latex.findDelimitedMath("$$  $$"), []);
});

test("findDelimitedMath stops after its optional result limit", () => {
  const input = "$x$ ".repeat(100000);
  const originalSlice = String.prototype.slice;
  const OriginalUint8Array = globalThis.Uint8Array;
  let delimiterIndexAllocations = 0;
  let expressionSlices = 0;
  let expressions;

  globalThis.Uint8Array = class extends OriginalUint8Array {
    constructor(...args) {
      super(...args);
      delimiterIndexAllocations++;
    }
  };
  String.prototype.slice = function (start, end) {
    if (this === input && end - start === 3)
      expressionSlices++;
    return Reflect.apply(originalSlice, this, [start, end]);
  };
  try {
    expressions = latex.findDelimitedMath(input, 51);
  } finally {
    String.prototype.slice = originalSlice;
    globalThis.Uint8Array = OriginalUint8Array;
  }

  assert.equal(expressions.length, 51);
  assert.equal(expressionSlices, 51);
  assert.equal(delimiterIndexAllocations, 0);
  assert.deepEqual(expressions.at(-1), {
    end: 203,
    start: 200,
    text: "$x$"
  });
  assert.equal(latex.findDelimitedMath("$x$ and $y$").length, 2);
  assert.deepEqual(latex.findDelimitedMath("$x$", 0), []);
  assert.throws(
    () => latex.findDelimitedMath("$x$", -1),
    /non-negative integer/
  );
});

test("bounded results match the default parser prefix", () => {
  const input = String.raw`Skip \$5; \(x\\)y\), $$z$$, \[w\], $q$, then \(r\).`;
  const all = latex.findDelimitedMath(input);

  assert.deepEqual(latex.findDelimitedMath(input, 3), all.slice(0, 3));
  assert.ok(all.length > 3);
});

test("findDelimitedMath does not treat common dollar amounts as math", () => {
  assert.deepEqual(
    latex.findDelimitedMath("The items cost $10 and $20 today."),
    []
  );
  assert.deepEqual(latex.findDelimitedMath("$1+1=2$"), [{
    end: 7,
    start: 0,
    text: "$1+1=2$"
  }]);
  assert.deepEqual(latex.findDelimitedMath("$ x$ and $y $"), []);
  assert.deepEqual(latex.findDelimitedMath("$x\ny$"), []);
  assert.deepEqual(latex.findDelimitedMath("$x + y$"), [{
    end: 7,
    start: 0,
    text: "$x + y$"
  }]);
});

test("findDelimitedMath scans repeated unmatched openers linearly", () => {
  const input = String.raw`\(`.repeat(2000);
  const originalStartsWith = String.prototype.startsWith;
  let startsWithCalls = 0;
  let expressions;

  String.prototype.startsWith = function (...args) {
    startsWithCalls++;
    return Reflect.apply(originalStartsWith, this, args);
  };
  try {
    expressions = latex.findDelimitedMath(input);
  } finally {
    String.prototype.startsWith = originalStartsWith;
  }

  assert.deepEqual(expressions, []);
  assert.ok(
    startsWithCalls <= input.length * 10,
    `${startsWithCalls} delimiter checks for ${input.length} characters`
  );
});

test("bounded delimiter scans do not rescan unmatched opener suffixes", () => {
  const input = String.raw`\(`.repeat(20000);
  const originalIndexOf = String.prototype.indexOf;
  let closingSearches = 0;
  let expressions;

  String.prototype.indexOf = function (search, ...args) {
    if (this === input && search === String.raw`\)`)
      closingSearches++;
    return Reflect.apply(originalIndexOf, this, [search, ...args]);
  };
  try {
    expressions = latex.findDelimitedMath(input, 51);
  } finally {
    String.prototype.indexOf = originalIndexOf;
  }

  assert.deepEqual(expressions, []);
  assert.equal(closingSearches, 1);
});
