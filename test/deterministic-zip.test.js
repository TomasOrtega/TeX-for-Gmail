"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const AdmZip = require("adm-zip");
const {
  createDeterministicZip
} = require("../scripts/deterministic-zip.js");
const { ZIP_DOS_TIMESTAMP } = require("../scripts/extension-targets.js");

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

test("deterministic ZIPs are sorted, compressed, and byte-stable", () => {
  const files = new Map([
    ["2", Buffer.from("second\n".repeat(200))],
    ["nested/caf\u00e9.txt", Buffer.from("unicode\n".repeat(200))],
    ["10", Buffer.from("first\n".repeat(200))]
  ]);

  const first = createDeterministicZip(files);
  const second = createDeterministicZip(new Map([...files].reverse()));
  assert.equal(sha256(first), sha256(second));
  assert.equal(
    sha256(first),
    "dc7e548a428cb09ac55d61bebb34c607c8c6b6cf6f831ff8a213b5cc8752c3f0"
  );
  assert.ok(first.length < 600, `expected compressed ZIP, got ${first.length} bytes`);

  const entries = new AdmZip(first).getEntries();
  assert.deepEqual(entries.map(entry => entry.entryName), [
    "10",
    "2",
    "nested/caf\u00e9.txt"
  ]);
  for (const entry of entries) {
    assert.equal(entry.header.method, 8, entry.entryName);
    assert.equal(entry.header.fileAttr, 0o644, entry.entryName);
    assert.equal(entry.header.timeval, ZIP_DOS_TIMESTAMP, entry.entryName);
    assert.ok(entry.getData().equals(files.get(entry.entryName)));
  }
});

test("deterministic ZIPs reject unsafe paths", () => {
  const unsafePaths = [
    "../escape",
    "/absolute",
    "C:/absolute",
    "back\\slash",
    "nul\0byte"
  ];
  for (const filename of unsafePaths)
    assert.throws(
      () => createDeterministicZip([[filename, Buffer.from("data")]]),
      /unsafe ZIP path/i
    );
});
