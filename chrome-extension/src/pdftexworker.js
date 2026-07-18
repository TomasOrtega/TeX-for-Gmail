"use strict";

importScripts("../resources/scripts/pdflatex.js");
importScripts("../resources/scripts/browserfs.min.js");
importScripts("communicator.js");

const TEXLIVE_BASE_URL = "../resources/texlive";

let thisWorker = self;
let comm = new Communicator(thisWorker);
let bfsWindow = {};
var pdflatexModule;
var buffer;
var resolveWorkerReady;
var rejectWorkerReady;
const MAX_TEX_SOURCE_LENGTH = 24000;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const WORKING_DIRECTORY = "/app/working";
const workerReady = new Promise((resolve, reject) => {
  resolveWorkerReady = resolve;
  rejectWorkerReady = reject;
});
BrowserFS.install(bfsWindow);

BrowserFS.configure({
  fs: "MountableFileSystem",
  options: {
    "/texlive": {
      fs: "XmlHttpRequest",
      options: {
        baseUrl: TEXLIVE_BASE_URL,
        index: "../resources/data/index.json",
        preferXHR: true
      }
    }
  }
}, function (e) {
  if (e) {
    rejectWorkerReady(e);
    return;
  }

  try {
    bfsWindow.fs = BrowserFS.BFSRequire('fs');
    pdflatexMod({
      print() {},
      printErr() {}
    }).then(m => {
      pdflatexModule = m;
      buffer = new ArrayBuffer(pdflatexModule.myWasmMem.buffer.byteLength);
      copyBuffer(pdflatexModule.myWasmMem.buffer, buffer);
      console.log(`${thisWorker.name} is ready!`);
      resolveWorkerReady();
    }).catch(rejectWorkerReady);
  } catch (ex) {
    rejectWorkerReady(ex);
  }
});

function copyBuffer(src, target) {
  (new Uint8Array(target)).set(new Uint8Array(src));
  return target;
}

function pdflatexMod(opts = {}) {
  return new Promise((resolve, reject) => {
    let onAbort = opts.onAbort;
    opts.onAbort = reason => {
      if (onAbort)
        onAbort(reason);
      reject(new Error(String(reason)));
    };

    try {
      pdflatex(opts).then2(m => resolve(m));
    } catch (ex) {
      reject(ex);
    }
  });
}

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
      payload: { err: ex.toString(), location: `pdftexworker.js, ready` }
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
        payload: { err: ex.toString(), location: location }
      };
    }
  };
}

// fileName is without extension
function compileHelper(srcCode, fileName, outputFile, params) {
  copyBuffer(buffer, pdflatexModule.myWasmMem.buffer);
  pdflatexModule.FS.writeFile(`${fileName}.tex`, srcCode);
  pdflatexModule.callMain([
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-no-shell-escape"
  ].concat(params));
  return pdflatexModule.FS.readFile(`${outputFile}`);
}

function requireSource(srcCode) {
  if (typeof srcCode !== "string" || !srcCode.trim())
    throw new Error("LaTeX source must be a non-empty string.");
  if (srcCode.length > MAX_TEX_SOURCE_LENGTH)
    throw new Error("LaTeX source is too long.");
  if (srcCode.includes("\0"))
    throw new Error("LaTeX source contains an invalid null character.");
}

function cleanupWorkingDirectory() {
  const fs = pdflatexModule?.FS;
  if (!fs ||
      typeof fs.readdir !== "function" ||
      typeof fs.unlink !== "function")
    return;

  let entries;
  try {
    entries = fs.readdir(WORKING_DIRECTORY);
  } catch {
    return;
  }
  for (let entry of entries) {
    if (entry === "." || entry === "..")
      continue;
    try {
      fs.unlink(`${WORKING_DIRECTORY}/${entry}`);
    } catch {}
  }
}

function compile(request) {
  let fileName = "source";
  try {
    if (!request || typeof request !== "object")
      throw new Error("Malformed compile request.");
    requireSource(request.srcCode);
    if (request.params !== undefined &&
        (!Array.isArray(request.params) || request.params.length !== 0))
      throw new Error("Custom compiler arguments are not supported.");

    let pdfFile = compileHelper(
      request.srcCode,
      fileName,
      `${fileName}.pdf`,
      [`${fileName}.tex`]
    );
    if (!(pdfFile instanceof Uint8Array) ||
        pdfFile.byteLength < 5 ||
        pdfFile[0] !== 0x25 ||
        pdfFile[1] !== 0x50 ||
        pdfFile[2] !== 0x44 ||
        pdfFile[3] !== 0x46 ||
        pdfFile[4] !== 0x2d)
      throw new Error("PDF output is invalid.");
    if (pdfFile.byteLength > MAX_PDF_BYTES)
      throw new Error("PDF output exceeds the size limit.");

    return {
      code: Communicator.SUCCESS,
      payload: { pdfFile: pdfFile }, // pdfFile is an Uint8Array
      transferList: [pdfFile.buffer]
    };
  } catch (ex) {
    return {
      code: Communicator.FAILURE,
      payload: { err: ex.toString(), location: `pdftexworker.js, compile` }
    };
  } finally {
    cleanupWorkingDirectory();
  }
}

comm.messageHandler.ready = ready;
comm.messageHandler.compile = afterReady(compile, `pdftexworker.js, compile`);
