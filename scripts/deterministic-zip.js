"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Zip, ZipDeflate } = require("fflate");
const { compareNames } = require("./release-files.js");

const COMPRESSION_LEVEL = 9;
const FILE_MODE = 0o644;
const UNIX_ORIGIN = 3;
// ZIP stores local date fields, so construct the fixed time locally.
const ZIP_MTIME = new Date(2000, 0, 1);

function fail(message) {
  throw new Error(message);
}

function requireSafeZipPath(filename) {
  const segments = typeof filename === "string" ? filename.split("/") : [];
  if (typeof filename !== "string" ||
      filename.length === 0 ||
      filename.endsWith("/") ||
      filename.includes("\0") ||
      filename.includes("\\") ||
      path.posix.isAbsolute(filename) ||
      path.win32.isAbsolute(filename) ||
      path.posix.normalize(filename) !== filename ||
      segments.some(segment => segment === "." || segment === "..")) {
    fail(`Unsafe ZIP path: ${JSON.stringify(filename)}`);
  }
  if (Buffer.byteLength(filename, "utf8") > 0xffff)
    fail(`ZIP path is too long: ${JSON.stringify(filename)}`);
  return filename;
}

function normalizeEntries(files) {
  if (!files || typeof files[Symbol.iterator] !== "function")
    fail("ZIP files must be an iterable of [path, contents] entries");

  const entries = [];
  const names = new Set();
  for (const item of files) {
    if (!Array.isArray(item) || item.length !== 2)
      fail("ZIP files must contain [path, contents] entries");
    const [filename, contents] = item;
    requireSafeZipPath(filename);
    if (names.has(filename))
      fail(`Duplicate ZIP path: ${filename}`);
    if (!(contents instanceof Uint8Array))
      fail(`ZIP contents must be bytes: ${filename}`);
    names.add(filename);
    entries.push([filename, contents]);
  }
  return entries.sort(([left], [right]) => compareNames(left, right));
}

function createDeterministicZip(files) {
  const chunks = [];
  let failure;
  const archive = new Zip((error, chunk) => {
    if (error)
      failure ||= error;
    else if (chunk)
      chunks.push(Buffer.from(chunk));
  });

  for (const [filename, contents] of normalizeEntries(files)) {
    const entry = new ZipDeflate(filename, { level: COMPRESSION_LEVEL });
    entry.attrs = FILE_MODE << 16;
    entry.mtime = ZIP_MTIME;
    entry.os = UNIX_ORIGIN;
    archive.add(entry);
    entry.push(contents, true);
    if (failure)
      throw failure;
  }
  archive.end();
  if (failure)
    throw failure;
  return Buffer.concat(chunks);
}

function writeDeterministicZip(filename, files) {
  const contents = createDeterministicZip(files);
  fs.mkdirSync(path.dirname(filename), { mode: 0o755, recursive: true });
  fs.writeFileSync(filename, contents, { mode: FILE_MODE });
  fs.chmodSync(filename, FILE_MODE);
  return contents.length;
}

module.exports = {
  createDeterministicZip,
  writeDeterministicZip
};
