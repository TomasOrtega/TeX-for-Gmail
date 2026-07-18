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

function sourcePath(filename) {
  return path.join(
    __dirname,
    "..",
    "chrome-extension",
    "src",
    filename
  );
}

function loadChromeServiceWorker(options = {}) {
  const createCalls = [];
  const createdMenus = [];
  const imports = [];
  const onClicked = createEvent();
  const onCommand = createEvent();
  const onInstalled = createEvent();
  const onMessage = createEvent();
  let getContextsCalls = 0;

  const chrome = {
    commands: {
      onCommand
    },
    contextMenus: {
      create(menu, callback) {
        createdMenus.push(menu);
        callback?.();
      },
      onClicked,
      remove(_id, callback) {
        callback?.();
      }
    },
    offscreen: {
      createDocument(parameters) {
        createCalls.push(parameters);
        if (options.createDocument)
          return options.createDocument(parameters);
        return Promise.resolve();
      }
    },
    runtime: {
      getContexts() {
        getContextsCalls++;
        return Promise.resolve(options.contexts || []);
      },
      getManifest() {
        return { manifest_version: 3 };
      },
      getURL(filename) {
        return `chrome-extension://test/${filename}`;
      },
      lastError: null,
      onInstalled,
      onMessage
    },
    tabs: {
      query(_query, callback) {
        callback([]);
      },
      sendMessage(_tabId, _message, callback) {
        callback?.();
      }
    }
  };

  let context;
  context = vm.createContext({
    chrome,
    console: {
      warn() {}
    },
    importScripts(filename) {
      imports.push(filename);
      vm.runInContext(
        fs.readFileSync(sourcePath(filename), "utf8"),
        context,
        { filename: sourcePath(filename) }
      );
    },
    Promise
  });
  vm.runInContext(
    fs.readFileSync(sourcePath("chrome-service-worker.js"), "utf8"),
    context,
    { filename: sourcePath("chrome-service-worker.js") }
  );

  return {
    chrome,
    createCalls,
    createdMenus,
    getContextsCalls: () => getContextsCalls,
    imports,
    onInstalled,
    onMessage
  };
}

function requestRenderer(runtime, sender = {
  url: "https://mail.google.com/mail/u/0/#inbox"
}) {
  const listener = runtime.onMessage.listeners[0];
  return new Promise(resolve => {
    assert.equal(
      listener(
        { type: "tex-for-gmail:ensure-renderer" },
        sender,
        resolve
      ),
      true
    );
  });
}

test("Chrome creates one offscreen renderer for concurrent requests", async () => {
  let resolveCreation;
  const creation = new Promise(resolve => {
    resolveCreation = resolve;
  });
  const runtime = loadChromeServiceWorker({
    createDocument() {
      return creation;
    }
  });

  const first = requestRenderer(runtime);
  const second = requestRenderer(runtime);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(runtime.createCalls.length, 1);
  assert.deepEqual({
    ...runtime.createCalls[0],
    reasons: [...runtime.createCalls[0].reasons]
  }, {
    justification: "Run the packaged pdfTeX and MuPDF workers locally.",
    reasons: ["WORKERS"],
    url: "src/chrome-offscreen.html"
  });
  resolveCreation();

  assert.deepEqual({ ...await first }, { ok: true });
  assert.deepEqual({ ...await second }, { ok: true });
  assert.deepEqual(runtime.imports, ["controller.js"]);
  assert.equal(runtime.getContextsCalls(), 2);
});

test("Chrome reuses an existing offscreen renderer", async () => {
  const runtime = loadChromeServiceWorker({
    contexts: [{
      contextType: "OFFSCREEN_DOCUMENT"
    }]
  });

  assert.deepEqual({ ...await requestRenderer(runtime) }, { ok: true });
  assert.equal(runtime.createCalls.length, 0);
});

test("Chrome reports bootstrap failures and permits a retry", async () => {
  let attempt = 0;
  const runtime = loadChromeServiceWorker({
    createDocument() {
      attempt++;
      return attempt === 1
        ? Promise.reject(new Error("offscreen creation failed"))
        : Promise.resolve();
    }
  });

  assert.deepEqual({ ...await requestRenderer(runtime) }, {
    error: "offscreen creation failed",
    ok: false
  });
  assert.deepEqual({ ...await requestRenderer(runtime) }, { ok: true });
  assert.equal(runtime.createCalls.length, 2);
});

test("Chrome creates context menus only from installation events", () => {
  const runtime = loadChromeServiceWorker();

  assert.equal(runtime.createdMenus.length, 0);
  assert.equal(runtime.onInstalled.listeners.length, 1);
  runtime.onInstalled.listeners[0]();
  assert.equal(runtime.createdMenus.length, 1);
  assert.equal(runtime.createdMenus[0].id, "tex-for-gmail-render");
});
