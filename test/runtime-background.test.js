"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function loadBackground(fixtures = {}) {
  const communicators = [];
  const poolInstances = [];
  const sentMessages = [];
  const createdMenus = [];
  const timers = [];
  const warnings = [];
  const workers = [];
  const onClicked = createEvent();
  const onCommand = createEvent();
  const onConnect = createEvent();
  const onInstalled = createEvent();
  const onMessage = createEvent();

  class FakeCommunicator {
    static get FAILURE() {
      return "0";
    }

    static get SUCCESS() {
      return "1";
    }

    constructor(target) {
      this.target = target;
      this.messageHandler = {};
      communicators.push(this);
    }
  }

  class FakePool {
    constructor(options) {
      this.options = options;
      this.name = options.name;
      this.destroyed = false;
      this.multiplier = options.multiplier;
      this.realPool = [];
      this.commands = [];
      this.processOptions = [];
      poolInstances.push(this);
    }

    async process(task, processOptions) {
      this.processOptions.push(processOptions);
      const comm = {
        request: async command => {
          this.commands.push(command);
          if (command === "ready")
            return { ready: true };
          if (command === "compile")
            return { pdfFile: new Uint8Array([37, 80, 68, 70, 45]) };
          if (command === "pdf2png")
            return {
              pngFile: fixtures.pngFile || new Uint8Array([
                137, 80, 78, 71, 13, 10, 26, 10
              ]).buffer
            };
          throw new Error(`Unexpected worker command: ${command}`);
        },
        target: {
          terminate() {}
        }
      };

      await this.options.initialize(comm);
      return task(comm);
    }

    destroy() {
      if (fixtures.destroyError)
        throw fixtures.destroyError;
      this.destroyed = true;
    }
  }

  const chrome = {
    commands: {
      onCommand
    },
    contextMenus: {
      create(options, callback) {
        createdMenus.push(options);
        if (callback)
          callback();
      },
      onClicked,
      remove(_id, callback) {
        if (callback)
          callback();
      }
    },
    runtime: {
      getManifest() {
        return {
          manifest_version: fixtures.manifestVersion || 2
        };
      },
      getURL(resourcePath) {
        return `moz-extension://test/${resourcePath}`;
      },
      lastError: null,
      onConnect,
      onInstalled,
      onMessage
    },
    tabs: {
      query(_query, callback) {
        if (fixtures.queryError)
          chrome.runtime.lastError = fixtures.queryError;
        callback([{
          id: 7,
          url: "https://mail.google.com/mail/u/0/#inbox"
        }]);
        chrome.runtime.lastError = null;
      },
      sendMessage(tabId, message, callback) {
        sentMessages.push({ tabId, message });
        if (callback)
          callback();
      }
    }
  };

  let workerCount = 0;
  class FakeWorker {
    constructor(url, options) {
      workerCount++;
      this.options = options;
      this.url = url;
      workers.push(this);
    }
  }

  const context = vm.createContext({
    ArrayBuffer,
    Blob,
    Communicator: FakeCommunicator,
    console: {
      error() {},
      log() {},
      warn(warning) {
        warnings.push(warning);
      }
    },
    chrome,
    clearTimeout(timer) {
      if (timer)
        timer.cleared = true;
    },
    Pool: FakePool,
    PortWrapper: class {},
    Promise,
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    Uint8Array,
    URL: {
      createObjectURL() {
        return "blob:test";
      },
      revokeObjectURL() {}
    },
    Worker: FakeWorker,
    btoa(binary) {
      return Buffer.from(binary, "binary").toString("base64");
    },
    random_id() {
      return "worker";
    }
  });

  const filename = path.join(
    __dirname,
    "..",
    "chrome-extension",
    "src",
    "background.js"
  );
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  const controllerFilename = path.join(
    __dirname,
    "..",
    "chrome-extension",
    "src",
    "controller.js"
  );
  vm.runInContext(
    fs.readFileSync(controllerFilename, "utf8"),
    context,
    { filename: controllerFilename }
  );

  return {
    chrome,
    communicators,
    context,
    createdMenus,
    onClicked,
    onCommand,
    onMessage,
    poolInstances,
    sentMessages,
    timers,
    warnings,
    workers,
    workerCount: () => workerCount
  };
}

test("background defers worker pools until compilation is requested", () => {
  const runtime = loadBackground();

  assert.equal(runtime.poolInstances.length, 0);
  assert.equal(runtime.workerCount(), 0);
});

test("PNG compilation returns a Firefox-port-safe data URL", async () => {
  const runtime = loadBackground();
  const compile2pngDataURL = vm.runInContext(
    "compile2pngDataURL",
    runtime.context
  );

  const response = await compile2pngDataURL({
    alpha: 0,
    scale: 2,
    srcCode: String.raw`\documentclass{article}`
  });

  assert.equal(response.code, "1");
  assert.equal(
    response.payload.dataUrl,
    "data:image/png;base64,iVBORw0KGgo="
  );
  assert.deepEqual(
    runtime.poolInstances.map(pool => [pool.name, ...pool.commands]),
    [
      ["pdftexWorkerPool", "ready", "compile"],
      ["mupdfWorkerPool", "ready", "pdf2png"]
    ]
  );
  assert.equal(runtime.poolInstances[0].options.count, 1);
  assert.deepEqual(
    runtime.poolInstances.map(pool => pool.processOptions[0]?.timeoutMs),
    [30000, 15000]
  );
  assert.equal(
    runtime.poolInstances.every(
      pool => pool.processOptions[0]?.retireOnError === true
    ),
    true
  );
});

test("worker factories resolve packaged URLs and worker options", async () => {
  const runtime = loadBackground();
  const compile2pngDataURL = vm.runInContext(
    "compile2pngDataURL",
    runtime.context
  );
  await compile2pngDataURL({
    alpha: 1,
    scale: 2,
    srcCode: String.raw`\documentclass{article}`
  });

  const pdftex = runtime.poolInstances[0].options.cons();
  const mupdf = runtime.poolInstances[1].options.cons();
  const moduleWorker = vm.runInContext(
    "workerCommunicator('module.js', 'module-worker', 'module')",
    runtime.context
  );

  assert.equal(pdftex.target.url, "moz-extension://test/src/pdftexworker.js");
  assert.equal(pdftex.target.options.name, "pdftexworker-worker");
  assert.equal(mupdf.target.url, "moz-extension://test/src/mupdfworker.js");
  assert.equal(mupdf.target.options.name, "mupdfworker-worker");
  assert.equal(moduleWorker.target.options.type, "module");
  assert.equal(runtime.workerCount(), 3);
});

test("render requests are validated before workers are created", async () => {
  const runtime = loadBackground();
  const compile2pngDataURL = vm.runInContext(
    "compile2pngDataURL",
    runtime.context
  );

  await assert.rejects(
    compile2pngDataURL({
      alpha: 1,
      scale: 2,
      srcCode: "x".repeat(24001)
    }),
    /too long/i
  );
  await assert.rejects(
    compile2pngDataURL({
      alpha: 1,
      scale: 100,
      srcCode: "x"
    }),
    /scale/i
  );

  assert.equal(runtime.poolInstances.length, 0);
});

test("background rejects malformed PNG worker output", async () => {
  const runtime = loadBackground({
    pngFile: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer
  });
  const compile2pngDataURL = vm.runInContext(
    "compile2pngDataURL",
    runtime.context
  );

  await assert.rejects(
    compile2pngDataURL({
      alpha: 1,
      scale: 2,
      srcCode: String.raw`\documentclass{article}`
    }),
    /PNG output has an invalid signature/i
  );
});

test("background ports are restricted to Gmail content scripts", () => {
  const runtime = loadBackground();
  let disconnected = false;

  runtime.chrome.runtime.onConnect.listeners[0]({
    disconnect() {
      disconnected = true;
    },
    sender: {
      url: "https://example.com/"
    }
  });
  assert.equal(disconnected, true);

  const onDisconnect = createEvent();
  runtime.chrome.runtime.onConnect.listeners[0]({
    name: "gmail",
    onDisconnect,
    sender: {
      url: "https://mail.google.com/mail/u/0/#inbox"
    }
  });

  assert.deepEqual(
    Object.keys(runtime.communicators.at(-1).messageHandler),
    ["compile2pngDataURL"]
  );
});

test("controller bootstraps the renderer only for Gmail senders", async () => {
  const runtime = loadBackground();
  const listener = runtime.onMessage.listeners[0];
  let response;

  assert.equal(listener({ type: "unrelated" }, {}, () => {}), undefined);
  assert.equal(
    listener(
      { type: "tex-for-gmail:ensure-renderer" },
      { url: "https://example.com/" },
      value => {
        response = value;
      }
    ),
    false
  );
  assert.deepEqual({ ...response }, {
    error: "Renderer initialization is restricted to Gmail.",
    ok: false
  });

  assert.equal(
    listener(
      { type: "tex-for-gmail:ensure-renderer" },
      {
        tab: {
          url: "https://mail.google.com/mail/u/0/#inbox"
        }
      },
      value => {
        response = value;
      }
    ),
    true
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual({ ...response }, { ok: true });
});

test("worker pools are released after the last Gmail port disconnects", async () => {
  const runtime = loadBackground();
  const compile2pngDataURL = vm.runInContext(
    "compile2pngDataURL",
    runtime.context
  );
  await compile2pngDataURL({
    alpha: 1,
    scale: 2,
    srcCode: String.raw`\documentclass{article}`
  });

  const onDisconnect = createEvent();
  runtime.chrome.runtime.onConnect.listeners[0]({
    name: "gmail",
    onDisconnect,
    sender: {
      url: "https://mail.google.com/mail/u/0/#inbox"
    }
  });
  onDisconnect.listeners[0]();

  assert.equal(runtime.poolInstances.length, 2);
  assert.equal(
    runtime.poolInstances.every(pool => pool.destroyed),
    true
  );
});

test("worker pools are released after five idle minutes", async () => {
  const runtime = loadBackground();
  const compile2pngDataURL = vm.runInContext(
    "compile2pngDataURL",
    runtime.context
  );
  await compile2pngDataURL({
    alpha: 1,
    scale: 2,
    srcCode: String.raw`\documentclass{article}`
  });

  assert.equal(runtime.timers.length, 1);
  assert.equal(runtime.timers[0].delay, 5 * 60 * 1000);
  runtime.timers[0].callback();
  assert.equal(
    runtime.poolInstances.every(pool => pool.destroyed),
    true
  );

  await compile2pngDataURL({
    alpha: 1,
    scale: 2,
    srcCode: String.raw`\documentclass{article}`
  });
  assert.equal(runtime.poolInstances.length, 4);
  assert.equal(
    runtime.poolInstances.slice(-2).every(pool => !pool.destroyed),
    true
  );
});

test("background reports worker cleanup and active-tab lookup failures", async () => {
  const cleanupError = new Error("worker cleanup failed");
  const cleanupRuntime = loadBackground({ destroyError: cleanupError });
  const compile2pngDataURL = vm.runInContext(
    "compile2pngDataURL",
    cleanupRuntime.context
  );
  await compile2pngDataURL({
    alpha: 1,
    scale: 2,
    srcCode: String.raw`\documentclass{article}`
  });

  vm.runInContext("destroyWorkerPools()", cleanupRuntime.context);
  assert.deepEqual(cleanupRuntime.warnings, [cleanupError, cleanupError]);

  const queryError = { message: "tab lookup failed" };
  const queryRuntime = loadBackground({ queryError });
  queryRuntime.onCommand.listeners[0]("render-selection");
  assert.deepEqual(queryRuntime.warnings, ["tab lookup failed"]);
  assert.equal(queryRuntime.sentMessages.length, 0);
});

test("data URL encoding preserves large typed-array views", () => {
  const runtime = loadBackground();
  const base64Encode = vm.runInContext("base64Encode", runtime.context);
  const source = new Uint8Array(70010);
  source.fill(0xff);
  source[5] = 0;
  source[70004] = 1;
  const view = source.subarray(5, 70005);

  const decoded = Buffer.from(base64Encode(view), "base64");

  assert.equal(decoded.length, view.length);
  assert.equal(decoded[0], 0);
  assert.equal(decoded[1], 0xff);
  assert.equal(decoded.at(-1), 1);
});

test("context menu and commands forward render requests to Gmail", () => {
  const runtime = loadBackground();

  assert.equal(runtime.onClicked.listeners.length, 1);
  assert.equal(runtime.onCommand.listeners.length, 1);
  assert.equal(runtime.createdMenus.length, 1);

  runtime.onClicked.listeners[0](
    {
      menuItemId: runtime.createdMenus[0].id,
      selectionText: "$x^2$"
    },
    {
      id: 5,
      url: "https://mail.google.com/mail/u/0/#inbox"
    }
  );
  runtime.onCommand.listeners[0]("render-latex");

  assert.equal(runtime.sentMessages.length, 1);
  assert.equal(runtime.sentMessages[0].tabId, 5);
  assert.equal(runtime.sentMessages[0].message.type, "tex-for-gmail:render");
  assert.equal(runtime.sentMessages[0].message.latex, "$x^2$");
  runtime.onCommand.listeners[0]("render-selection");

  assert.equal(runtime.sentMessages.length, 2);
  assert.equal(runtime.sentMessages[1].tabId, 7);
  assert.equal(runtime.sentMessages[1].message.type, "tex-for-gmail:render");
  assert.equal(
    Object.hasOwn(runtime.sentMessages[1].message, "latex"),
    false
  );
});
