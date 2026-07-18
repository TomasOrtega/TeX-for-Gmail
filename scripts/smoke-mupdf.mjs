#!/usr/bin/env node

import assert from "node:assert/strict";
import * as mupdf from "../chrome-extension/resources/mupdf/mupdf.js";

const source = new mupdf.PDFDocument();
const pageObject = source.addPage([0, 0, 32, 16], 0, {}, "");
source.insertPage(-1, pageObject);
pageObject.destroy();

const serialized = source.saveToBuffer();
const pdf = serialized.asUint8Array().slice();
serialized.destroy();
source.destroy();

const document = mupdf.Document.openDocument(pdf, "application/pdf");
assert.equal(document.countPages(), 1);
const page = document.loadPage(0);
assert.deepEqual(page.getBounds(), [0, 0, 32, 16]);
const pixmap = page.toPixmap(
  mupdf.Matrix.scale(2, 2),
  mupdf.ColorSpace.DeviceRGB,
  false
);
assert.equal(pixmap.getWidth(), 64);
assert.equal(pixmap.getHeight(), 32);
const png = pixmap.asPNG();
assert.deepEqual(
  Array.from(png.subarray(0, 8)),
  [137, 80, 78, 71, 13, 10, 26, 10]
);

pixmap.destroy();
page.destroy();
document.destroy();

console.log(`MuPDF 1.28.0 smoke test passed (${png.byteLength} PNG bytes).`);
