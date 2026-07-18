"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class FakeCommunicator {
  static get FAILURE() {
    return "0";
  }

  static get SUCCESS() {
    return "1";
  }

  constructor() {
    this.messageHandler = {};
    FakeCommunicator.instance = this;
  }
}

function workerPath(filename) {
  return path.join(
    __dirname,
    "..",
    "chrome-extension",
    "src",
    filename
  );
}

function workerSource(filename) {
  return fs.readFileSync(workerPath(filename), "utf8");
}

test("pdfTeX requests wait for filesystem and WASM initialization", async () => {
  let configureCallback;
  let resolveModule;
  let callMainCount = 0;
  let callMainArguments;
  let moduleOptions;
  let pdfOutput = new Uint8Array([37, 80, 68, 70, 45]);
  let readdirError;
  const unlinked = [];
  const module = {
    callMain(args) {
      callMainCount++;
      callMainArguments = Array.from(args);
    },
    FS: {
      readFile() {
        return pdfOutput;
      },
      readdir(directory) {
        assert.equal(directory, "/app/working");
        if (readdirError)
          throw readdirError;
        return [
          ".",
          "..",
          "source.tex",
          "source.pdf",
          "source.log",
          "source.synctex.gz",
          "unexpected.tmp",
          "nested"
        ];
      },
      unlink(filename) {
        unlinked.push(filename);
        if (filename.endsWith("/nested"))
          throw new Error("is a directory");
      },
      writeFile() {}
    },
    myWasmMem: {
      buffer: new ArrayBuffer(8)
    }
  };
  const context = vm.createContext({
    ArrayBuffer,
    BrowserFS: {
      BFSRequire() {
        return {};
      },
      configure(_options, callback) {
        configureCallback = callback;
      },
      install() {}
    },
    Communicator: FakeCommunicator,
    console: {
      log() {}
    },
    importScripts() {},
    pdflatex(options) {
      moduleOptions = options;
      return {
        then2(callback) {
          resolveModule = () => callback(module);
        }
      };
    },
    Promise,
    self: {
      name: "pdftex-test"
    },
    Uint8Array
  });

  vm.runInContext(workerSource("pdftexworker.js"), context, {
    filename: workerPath("pdftexworker.js")
  });
  const comm = FakeCommunicator.instance;
  assert.equal(typeof comm.messageHandler.ready, "function");

  let readySettled = false;
  const readiness = comm.messageHandler.ready().then(response => {
    readySettled = true;
    return response;
  });
  let settled = false;
  const compilation = Promise.resolve(
    comm.messageHandler.compile({
      params: [],
      srcCode: String.raw`\documentclass{article}`
    })
  ).then(result => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(readySettled, false);
  assert.equal(settled, false);
  assert.equal(callMainCount, 0);

  configureCallback(null);
  resolveModule();
  assert.equal((await readiness).code, "1");
  assert.equal(typeof moduleOptions.print, "function");
  assert.equal(typeof moduleOptions.printErr, "function");
  const result = await compilation;

  assert.equal(result.code, "1");
  assert.equal(callMainCount, 1);
  assert.deepEqual(callMainArguments, [
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-no-shell-escape",
    "source.tex"
  ]);
  assert.deepEqual(unlinked, [
    "/app/working/source.tex",
    "/app/working/source.pdf",
    "/app/working/source.log",
    "/app/working/source.synctex.gz",
    "/app/working/unexpected.tmp",
    "/app/working/nested"
  ]);

  const oversized = await comm.messageHandler.compile({
    params: [],
    srcCode: "x".repeat(24001)
  });
  assert.equal(oversized.code, "0");
  assert.match(oversized.payload.err, /too long/i);
  assert.equal(callMainCount, 1);

  const customArguments = await comm.messageHandler.compile({
    params: ["-shell-escape"],
    srcCode: String.raw`\documentclass{article}`
  });
  assert.equal(customArguments.code, "0");
  assert.match(customArguments.payload.err, /arguments/i);
  assert.equal(callMainCount, 1);

  const nullCharacter = await comm.messageHandler.compile({
    srcCode: "x\0y"
  });
  assert.equal(nullCharacter.code, "0");
  assert.match(nullCharacter.payload.err, /null character/i);

  pdfOutput = new Uint8Array([0, 1, 2, 3, 4]);
  const invalidPdf = await comm.messageHandler.compile({
    srcCode: String.raw`\documentclass{article}`
  });
  assert.equal(invalidPdf.code, "0");
  assert.match(invalidPdf.payload.err, /PDF output is invalid/i);
  assert.equal(callMainCount, 2);

  pdfOutput = new Uint8Array([37, 80, 68, 70, 45]);
  readdirError = new Error("working directory unavailable");
  const cleanupFailure = await comm.messageHandler.compile({
    srcCode: String.raw`\documentclass{article}`
  });
  assert.equal(cleanupFailure.code, "1");
  assert.equal(callMainCount, 3);
});

test("pdfTeX reports filesystem initialization failures", async () => {
  const context = vm.createContext({
    BrowserFS: {
      configure(_options, callback) {
        callback(new Error("filesystem unavailable"));
      },
      install() {}
    },
    Communicator: FakeCommunicator,
    importScripts() {},
    Promise,
    self: {},
    Uint8Array
  });

  vm.runInContext(workerSource("pdftexworker.js"), context, {
    filename: workerPath("pdftexworker.js")
  });
  const comm = FakeCommunicator.instance;

  const ready = await comm.messageHandler.ready();
  assert.equal(ready.code, "0");
  assert.match(ready.payload.err, /filesystem unavailable/i);

  const compile = await comm.messageHandler.compile({
    srcCode: String.raw`\documentclass{article}`
  });
  assert.equal(compile.code, "0");
  assert.match(compile.payload.err, /filesystem unavailable/i);
});

test("pdfTeX contains synchronous setup and engine abort failures", async () => {
  const context = vm.createContext({
    ArrayBuffer,
    BrowserFS: {
      BFSRequire() {
        throw new Error("filesystem module unavailable");
      },
      configure(_options, callback) {
        callback(null);
      },
      install() {}
    },
    Communicator: FakeCommunicator,
    console: {
      log() {}
    },
    importScripts() {},
    pdflatex() {
      throw new Error("engine startup failed");
    },
    Promise,
    self: {},
    Uint8Array
  });

  vm.runInContext(workerSource("pdftexworker.js"), context, {
    filename: workerPath("pdftexworker.js")
  });
  const comm = FakeCommunicator.instance;
  const ready = await comm.messageHandler.ready();
  assert.equal(ready.code, "0");
  assert.match(ready.payload.err, /filesystem module unavailable/i);

  const pdflatexMod = vm.runInContext("pdflatexMod", context);
  await assert.rejects(
    pdflatexMod(),
    /engine startup failed/i
  );

  let moduleOptions;
  let originalAbortReason;
  context.pdflatex = options => {
    moduleOptions = options;
    return {
      then2() {}
    };
  };
  const aborted = pdflatexMod({
    onAbort(reason) {
      originalAbortReason = reason;
    }
  });
  moduleOptions.onAbort("engine aborted");

  await assert.rejects(aborted, /engine aborted/i);
  assert.equal(originalAbortReason, "engine aborted");
});

test("MuPDF requests wait for its packaged module and release resources", async () => {
  let resolveModule;
  let pageCount = 1;
  let width = 100;
  let boundsAreValid = true;
  let pixmapWidth;
  let pngOutput = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10
  ]);
  const destroyed = {
    document: 0,
    page: 0,
    pixmap: 0
  };
  const module = {
    ColorSpace: {
      DeviceRGB: {}
    },
    Document: {
      openDocument() {
        return {
          countPages() {
            return pageCount;
          },
          destroy() {
            destroyed.document++;
          },
          loadPage() {
            return {
              destroy() {
                destroyed.page++;
              },
              getBounds() {
                return boundsAreValid ? [0, 0, width, 100] : null;
              },
              toPixmap() {
                return {
                  asPNG() {
                    return pngOutput;
                  },
                  destroy() {
                    destroyed.pixmap++;
                  },
                  getHeight() {
                    return 100;
                  },
                  getWidth() {
                    return pixmapWidth ?? width;
                  }
                };
              }
            };
          }
        };
      }
    },
    Matrix: {
      scale(x, y) {
        return { x, y };
      }
    }
  };
  const moduleReady = new Promise(resolve => {
    resolveModule = () => resolve(module);
  });
  const context = vm.createContext({
    ArrayBuffer,
    Communicator: FakeCommunicator,
    console: {
      log() {}
    },
    importScripts() {},
    Promise,
    self: {
      __loadMupdfModule() {
        return moduleReady;
      },
      name: "mupdf-test"
    },
    Uint8Array
  });

  vm.runInContext(workerSource("mupdfworker.js"), context, {
    filename: workerPath("mupdfworker.js")
  });
  const comm = FakeCommunicator.instance;
  assert.equal(typeof comm.messageHandler.ready, "function");

  let readySettled = false;
  const readiness = comm.messageHandler.ready().then(response => {
    readySettled = true;
    return response;
  });
  let settled = false;
  const conversion = Promise.resolve(
    comm.messageHandler.pdf2png({
      alpha: 0,
      pageNo: 1,
      pdfFile: new Uint8Array([37, 80, 68, 70, 45]),
      scale: 1
    })
  ).then(result => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(readySettled, false);
  assert.equal(settled, false);

  resolveModule();
  assert.equal((await readiness).code, "1");
  const result = await conversion;

  assert.equal(result.code, "1");
  assert.deepEqual(destroyed, {
    document: 1,
    page: 1,
    pixmap: 1
  });
  assert.deepEqual(
    [...new Uint8Array(result.payload.pngFile)],
    [137, 80, 78, 71, 13, 10, 26, 10]
  );

  pageCount = 2;
  const multipage = await comm.messageHandler.pdf2png({
    alpha: 0,
    pageNo: 1,
    pdfFile: new Uint8Array([37, 80, 68, 70, 45]),
    scale: 1
  });
  assert.equal(multipage.code, "0");
  assert.match(multipage.payload.err, /one page/i);
  assert.equal(destroyed.document, 2);

  pageCount = 1;
  width = 5000;
  const oversized = await comm.messageHandler.pdf2png({
    alpha: 0,
    pageNo: 1,
    pdfFile: new Uint8Array([37, 80, 68, 70, 45]),
    scale: 1
  });
  assert.equal(oversized.code, "0");
  assert.match(oversized.payload.err, /dimensions/i);
  assert.equal(destroyed.document, 3);
  assert.equal(destroyed.page, 2);

  width = 100;
  pixmapWidth = 5000;
  const oversizedPixmap = await comm.messageHandler.pdf2png({
    alpha: 0,
    pageNo: 1,
    pdfFile: new Uint8Array([37, 80, 68, 70, 45]),
    scale: 1
  });
  assert.equal(oversizedPixmap.code, "0");
  assert.match(oversizedPixmap.payload.err, /dimensions/i);
  assert.deepEqual(destroyed, {
    document: 4,
    page: 3,
    pixmap: 2
  });

  pixmapWidth = undefined;
  boundsAreValid = false;
  const invalidBounds = await comm.messageHandler.pdf2png({
    alpha: 0,
    pageNo: 1,
    pdfFile: new Uint8Array([37, 80, 68, 70, 45]),
    scale: 1
  });
  assert.equal(invalidBounds.code, "0");
  assert.match(invalidBounds.payload.err, /bounds/i);
  assert.equal(destroyed.document, 5);
  assert.equal(destroyed.page, 4);

  const invalidPdf = await comm.messageHandler.pdf2png({
    alpha: 0,
    pageNo: 1,
    pdfFile: new Uint8Array([0, 1, 2, 3, 4]),
    scale: 1
  });
  assert.equal(invalidPdf.code, "0");
  assert.match(invalidPdf.payload.err, /signature/i);
  assert.equal(destroyed.document, 5);

  for (const invalidOptions of [
    { alpha: 0, pageNo: 1, scale: 10 },
    { alpha: 0, pageNo: 2, scale: 1 },
    { alpha: 2, pageNo: 1, scale: 1 }
  ]) {
    const invalid = await comm.messageHandler.pdf2png({
      ...invalidOptions,
      pdfFile: new Uint8Array([37, 80, 68, 70, 45])
    });
    assert.equal(invalid.code, "0");
  }
  assert.equal(destroyed.document, 5);

  boundsAreValid = true;
  pngOutput = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const invalidPng = await comm.messageHandler.pdf2png({
    alpha: 0,
    pageNo: 1,
    pdfFile: new Uint8Array([37, 80, 68, 70, 45]),
    scale: 1
  });
  assert.equal(invalidPng.code, "0");
  assert.match(invalidPng.payload.err, /PNG output has an invalid signature/i);
});

test("MuPDF reports packaged module initialization failures", async () => {
  const context = vm.createContext({
    Communicator: FakeCommunicator,
    importScripts() {},
    Promise,
    self: {
      __loadMupdfModule() {
        return Promise.resolve({});
      }
    },
    Uint8Array
  });

  vm.runInContext(workerSource("mupdfworker.js"), context, {
    filename: workerPath("mupdfworker.js")
  });
  const comm = FakeCommunicator.instance;

  const ready = await comm.messageHandler.ready();
  assert.equal(ready.code, "0");
  assert.match(ready.payload.err, /module is invalid/i);

  const render = await comm.messageHandler.pdf2png({
    alpha: 0,
    pageNo: 1,
    pdfFile: new Uint8Array([37, 80, 68, 70, 45]),
    scale: 1
  });
  assert.equal(render.code, "0");
  assert.match(render.payload.err, /module is invalid/i);
});
