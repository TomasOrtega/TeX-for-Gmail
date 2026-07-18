"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

test("packaged MuPDF opens and rasterizes a PDF", () => {
  const root = path.join(__dirname, "..");
  const output = execFileSync(
    process.execPath,
    [path.join(root, "scripts", "smoke-mupdf.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30000
    }
  );

  assert.match(output, /MuPDF 1\.28\.0 smoke test passed/);
});
