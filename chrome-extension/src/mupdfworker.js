"use strict";

importScripts("communicator.js");

const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_RASTER_DIMENSION = 4096;
const MAX_RASTER_PIXELS = 16 * 1024 * 1024;
const MIN_RENDER_SCALE = 0.5;
const MAX_RENDER_SCALE = 4;

const thisWorker = self;
const comm = new Communicator(thisWorker);
const loadMupdfModule = typeof thisWorker.__loadMupdfModule === "function"
  ? thisWorker.__loadMupdfModule
  : () => import("../resources/mupdf/mupdf.js");
let mupdf;
const workerReady = Promise.resolve()
  .then(loadMupdfModule)
  .then(module => {
    if (!module?.Document ||
        !module?.Matrix ||
        !module?.ColorSpace?.DeviceRGB)
      throw new Error("The packaged MuPDF module is invalid.");
    mupdf = module;
  });

async function ready() {
  try {
    await workerReady;
    return {
      code: Communicator.SUCCESS,
      payload: { ready: true }
    };
  } catch (ex) {
    return {
      code: Communicator.FAILURE,
      payload: { err: ex.toString(), location: "mupdfworker.js, ready" }
    };
  }
}

function afterReady(handler, location) {
  return async params => {
    try {
      await workerReady;
      return await handler(params);
    } catch (ex) {
      return {
        code: Communicator.FAILURE,
        payload: { err: ex.toString(), location }
      };
    }
  };
}

function requirePdfFile(pdfFile) {
  if (!(pdfFile instanceof Uint8Array))
    throw new Error("PDF input must be a byte array.");
  if (pdfFile.byteLength < 5 || pdfFile.byteLength > MAX_PDF_BYTES)
    throw new Error("PDF input exceeds the size limit or is empty.");
  if (pdfFile[0] !== 0x25 ||
      pdfFile[1] !== 0x50 ||
      pdfFile[2] !== 0x44 ||
      pdfFile[3] !== 0x46 ||
      pdfFile[4] !== 0x2d)
    throw new Error("PDF input has an invalid signature.");
}

function requirePngFile(png) {
  if (!(png instanceof Uint8Array) ||
      png.byteLength < 8 ||
      png.byteLength > MAX_PNG_BYTES)
    throw new Error("PNG output exceeds the size limit or is empty.");
  if (png[0] !== 0x89 ||
      png[1] !== 0x50 ||
      png[2] !== 0x4e ||
      png[3] !== 0x47 ||
      png[4] !== 0x0d ||
      png[5] !== 0x0a ||
      png[6] !== 0x1a ||
      png[7] !== 0x0a)
    throw new Error("PNG output has an invalid signature.");
}

function requireRenderOptions(scale, pageNo, alpha) {
  if (!Number.isFinite(scale) ||
      scale < MIN_RENDER_SCALE ||
      scale > MAX_RENDER_SCALE)
    throw new Error(
      `Render scale must be between ${MIN_RENDER_SCALE} and ${MAX_RENDER_SCALE}.`
    );
  if (pageNo !== 1)
    throw new Error("Only the first page can be rendered.");
  if (alpha !== 0 && alpha !== 1)
    throw new Error("Alpha must be either 0 or 1.");
}

function requireDimensions(width, height) {
  if (!Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 1 ||
      height < 1 ||
      width > MAX_RASTER_DIMENSION ||
      height > MAX_RASTER_DIMENSION ||
      width * height > MAX_RASTER_PIXELS)
    throw new Error("Rendered page dimensions exceed the safety limit.");
}

function requirePage(pdfDoc, scale) {
  if (pdfDoc.countPages() !== 1)
    throw new Error("Rendered documents must contain exactly one page.");

  const page = pdfDoc.loadPage(0);
  const bounds = page.getBounds();
  if (!Array.isArray(bounds) || bounds.length !== 4) {
    page.destroy();
    throw new Error("MuPDF returned invalid page bounds.");
  }

  try {
    requireDimensions(
      Math.ceil(Math.abs(bounds[2] - bounds[0]) * scale),
      Math.ceil(Math.abs(bounds[3] - bounds[1]) * scale)
    );
    return page;
  } catch (error) {
    page.destroy();
    throw error;
  }
}

function destroy(resource) {
  if (resource && typeof resource.destroy === "function")
    resource.destroy();
}

async function pdf2png(request) {
  let pdfDoc;
  let page;
  let pixmap;
  try {
    if (!request || typeof request !== "object")
      throw new Error("Malformed PDF render request.");
    const { pdfFile, scale, pageNo, alpha } = request;
    requirePdfFile(pdfFile);
    requireRenderOptions(scale, pageNo, alpha);

    pdfDoc = mupdf.Document.openDocument(pdfFile, "application/pdf");
    if (!pdfDoc)
      throw new Error("MuPDF could not open the generated PDF.");
    page = requirePage(pdfDoc, scale);
    pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      alpha === 1
    );
    requireDimensions(pixmap.getWidth(), pixmap.getHeight());

    const png = new Uint8Array(pixmap.asPNG());
    requirePngFile(png);
    const output = png.slice().buffer;

    return {
      code: Communicator.SUCCESS,
      payload: { pngFile: output },
      transferList: [output]
    };
  } catch (ex) {
    return {
      code: Communicator.FAILURE,
      payload: { err: ex.toString(), location: "mupdfworker.js, pdf2png" }
    };
  } finally {
    destroy(pixmap);
    destroy(page);
    destroy(pdfDoc);
  }
}

comm.messageHandler.ready = ready;
comm.messageHandler.pdf2png = afterReady(pdf2png, "mupdfworker.js, pdf2png");
