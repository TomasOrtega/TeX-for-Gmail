"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

test("packaged TeX resources compile the supported AMS fixture", () => {
  const root = path.join(__dirname, "..");
  const output = execFileSync(
    process.execPath,
    [path.join(root, "scripts", "trace-tex-resources.js"), "--local"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30000
    }
  );
  const result = JSON.parse(output);

  assert.equal(result.mode, "packaged");
  assert.ok(result.pdfBytes > 0);
});
