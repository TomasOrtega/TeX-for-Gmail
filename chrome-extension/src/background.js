"use strict";

console.log("TeX for Gmail renderer is ready.");

const DEFAULT_PDFTEX_POOL = { count: 1, multiplier: 1, maxQueue: 6 };
const DEFAULT_MUPDF_POOL = { count: 1, multiplier: 1, maxQueue: 4 };
const PDFTEX_TIMEOUT = {
  retireOnError: true,
  timeoutMs: 30000,
  timeoutMessage: "LaTeX compilation timed out."
};
const MUPDF_TIMEOUT = {
  retireOnError: true,
  timeoutMs: 15000,
  timeoutMessage: "Image rendering timed out."
};
const MAX_TEX_SOURCE_LENGTH = 24000;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MIN_RENDER_SCALE = 0.5;
const MAX_RENDER_SCALE = 4;
const WORKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const ports = new Map();
let pdftexWorkerPool;
let mupdfWorkerPool;
let activeRenders = 0;
let workerIdleTimer;

function destroyWorkerPools() {
  clearTimeout(workerIdleTimer);
  workerIdleTimer = undefined;
  for (let pool of [pdftexWorkerPool, mupdfWorkerPool]) {
    if (!pool || pool.destroyed)
      continue;
    try {
      pool.destroy();
    } catch (error) {
      console.warn(error);
    }
  }
}

function ensurePdftexWorkerPool() {
  if (!pdftexWorkerPool || pdftexWorkerPool.destroyed)
    setupPdftexWorkerPool(DEFAULT_PDFTEX_POOL);
  return pdftexWorkerPool;
}

function ensureMupdfWorkerPool() {
  if (!mupdfWorkerPool || mupdfWorkerPool.destroyed)
    setupMupdfWorkerPool(DEFAULT_MUPDF_POOL);
  return mupdfWorkerPool;
}

function workerCommunicator(scriptName, workerName, workerType) {
  let workerUrl = chrome.runtime.getURL
    ? chrome.runtime.getURL(`src/${scriptName}`)
    : scriptName;
  let options = { name: workerName };
  if (workerType)
    options.type = workerType;
  return new Communicator(new Worker(workerUrl, options));
}

function setupPdftexWorkerPool({
  count = DEFAULT_PDFTEX_POOL.count,
  multiplier = DEFAULT_PDFTEX_POOL.multiplier,
  maxQueue = DEFAULT_PDFTEX_POOL.maxQueue
} = {}) {
  if (pdftexWorkerPool && !pdftexWorkerPool.destroyed)
    pdftexWorkerPool.destroy();

  pdftexWorkerPool = new Pool({
    name: "pdftexWorkerPool",
    count: count,
    cons: () => workerCommunicator(
      "pdftexworker.js",
      `pdftexworker-${random_id(16)}`
    ),
    free: comm => comm.target.terminate(),
    autoRelease: true,
    initialize: comm => comm.request("ready", {}),
    multiplier: multiplier,
    maxQueue: maxQueue
  });

  return pdftexWorkerPool;
}

function setupMupdfWorkerPool({
  count = DEFAULT_MUPDF_POOL.count,
  multiplier = DEFAULT_MUPDF_POOL.multiplier,
  maxQueue = DEFAULT_MUPDF_POOL.maxQueue
} = {}) {
  if (mupdfWorkerPool && !mupdfWorkerPool.destroyed)
    mupdfWorkerPool.destroy();

  mupdfWorkerPool = new Pool({
    name: "mupdfWorkerPool",
    count: count,
    cons: () => workerCommunicator(
      "mupdfworker.js",
      `mupdfworker-${random_id(16)}`
    ),
    free: comm => comm.target.terminate(),
    autoRelease: true,
    initialize: comm => comm.request("ready", {}),
    multiplier: multiplier,
    maxQueue: maxQueue
  });

  return mupdfWorkerPool;
}

function requireSource(srcCode) {
  if (typeof srcCode !== "string" || !srcCode.trim())
    throw new Error("LaTeX source must be a non-empty string.");
  if (srcCode.length > MAX_TEX_SOURCE_LENGTH)
    throw new Error("LaTeX source is too long.");
  if (srcCode.includes("\0"))
    throw new Error("LaTeX source contains an invalid null character.");
  return srcCode;
}

function requireByteLength(file, maxBytes, label) {
  if (!file || !Number.isSafeInteger(file.byteLength))
    throw new Error(`${label} output is invalid.`);
  if (file.byteLength === 0)
    throw new Error(`${label} output is empty.`);
  if (file.byteLength > maxBytes)
    throw new Error(`${label} output exceeds the ${maxBytes} byte limit.`);
  return file;
}

function requirePdfFile(file) {
  if (!(file instanceof Uint8Array))
    throw new Error("PDF output must be a byte array.");
  requireByteLength(file, MAX_PDF_BYTES, "PDF");
  if (file.byteLength < 5 ||
      file[0] !== 0x25 ||
      file[1] !== 0x50 ||
      file[2] !== 0x44 ||
      file[3] !== 0x46 ||
      file[4] !== 0x2d)
    throw new Error("PDF output has an invalid signature.");
  return file;
}

function requirePngFile(file) {
  if (!(file instanceof ArrayBuffer))
    throw new Error("PNG output must be an array buffer.");
  requireByteLength(file, MAX_PNG_BYTES, "PNG");
  const bytes = new Uint8Array(file);
  if (bytes.byteLength < 8 ||
      bytes[0] !== 0x89 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x4e ||
      bytes[3] !== 0x47 ||
      bytes[4] !== 0x0d ||
      bytes[5] !== 0x0a ||
      bytes[6] !== 0x1a ||
      bytes[7] !== 0x0a)
    throw new Error("PNG output has an invalid signature.");
  return file;
}

function requireScale(scale) {
  if (!Number.isFinite(scale) ||
      scale < MIN_RENDER_SCALE ||
      scale > MAX_RENDER_SCALE)
    throw new Error(
      `Render scale must be between ${MIN_RENDER_SCALE} and ${MAX_RENDER_SCALE}.`
    );
  return scale;
}

function requireAlpha(alpha) {
  if (alpha !== 0 && alpha !== 1)
    throw new Error("Alpha must be either 0 or 1.");
  return alpha;
}

function validateRenderRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new Error("Malformed render request.");

  const allowed = new Set(["alpha", "scale", "srcCode"]);
  for (let key of Object.keys(request)) {
    if (!allowed.has(key))
      throw new Error(`Unexpected render option: ${key}.`);
  }

  return {
    alpha: requireAlpha(request.alpha),
    scale: requireScale(request.scale),
    srcCode: requireSource(request.srcCode)
  };
}

async function compile(srcCode) {
  requireSource(srcCode);
  let pool = ensurePdftexWorkerPool();
  return pool.process(async comm => {
    let res = await comm.request(
      "compile",
      { srcCode: srcCode });
    return requirePdfFile(res.pdfFile);
  },
    PDFTEX_TIMEOUT
  );
}

// pdfFile is an Uint8Array
async function pdf2png(pdfFile, scale, pageNo, alpha) {
  requirePdfFile(pdfFile);
  requireScale(scale);
  requireAlpha(alpha);
  if (pageNo !== 1)
    throw new Error("Only the first page can be rendered.");

  let pool = ensureMupdfWorkerPool();
  return pool.process(async comm => {
    let res = await comm.request(
      "pdf2png",
      { pdfFile: pdfFile, scale: scale, pageNo: pageNo, alpha: alpha },
      [pdfFile.buffer]);
    return requirePngFile(res.pngFile);
  },
    MUPDF_TIMEOUT
  );
}

async function compile2png(srcCode, scale, alpha) {
  let pdfFile = await compile(srcCode);
  let pngFile = await pdf2png(pdfFile, scale, 1, alpha);
  return new Uint8Array(pngFile);
}

function base64Encode(file) {
  let bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

async function toDataUrlFactory(f, tpe) {
  let dataUrl = `data:${tpe};base64,${base64Encode(await f())}`;
  return {
    code: Communicator.SUCCESS,
    payload: { dataUrl: dataUrl }
  };
}

async function compile2pngDataURL(request) {
  clearTimeout(workerIdleTimer);
  workerIdleTimer = undefined;
  activeRenders++;
  try {
    const { srcCode, scale, alpha } = validateRenderRequest(request);
    return await toDataUrlFactory(
      () => compile2png(srcCode, scale, alpha),
      'image/png'
    );
  } finally {
    activeRenders--;
    if (activeRenders === 0) {
      workerIdleTimer = setTimeout(
        destroyWorkerPools,
        WORKER_IDLE_TIMEOUT_MS
      );
    }
  }
}

function setupMessageHandler(comm) {
  comm.messageHandler.compile2pngDataURL = compile2pngDataURL;
}

function isGmailPort(port) {
  let senderUrl = port?.sender?.url || port?.sender?.tab?.url || "";
  return /^https:\/\/mail\.google\.com(?:\/|$)/.test(senderUrl);
}

chrome.runtime.onConnect.addListener(function (port) {
  if (!isGmailPort(port)) {
    port.disconnect();
    return;
  }

  let comm = new Communicator(new PortWrapper(port));
  ports.set(port, comm);
  setupMessageHandler(comm);

  port.onDisconnect.addListener(function () {
    ports.delete(port);
    if (ports.size === 0)
      destroyWorkerPools();
  });
});
