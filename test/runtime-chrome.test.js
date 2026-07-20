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
  const closeCalls = [];
  const imports = [];
  const onMessage = createEvent();
  const sentMessages = [];
  const warnings = [];
  let getContextsCalls = 0;

  const chrome = {
    offscreen: {
      closeDocument() {
        closeCalls.push(true);
        if (options.closeDocument)
          return options.closeDocument();
        return Promise.resolve();
      },
      createDocument(parameters) {
        createCalls.push(parameters);
        if (options.createDocument)
          return options.createDocument(parameters);
        return Promise.resolve();
      }
    },
    runtime: {
      id: "tex-for-gmail-test",
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
      onMessage,
      sendMessage(message) {
        sentMessages.push(message);
        if (options.sendMessage)
          return options.sendMessage(message);
        if (message.type ===
            "tex-for-gmail:prepare-idle-renderer-close")
          return Promise.resolve(options.prepareResult || { ok: true });
        return Promise.resolve({ ok: true });
      }
    }
  };

  let context;
  context = vm.createContext({
    chrome,
    console: {
      warn(warning) {
        warnings.push(warning);
      }
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
    closeCalls,
    createCalls,
    getContextsCalls: () => getContextsCalls,
    imports,
    onMessage,
    sentMessages,
    warnings
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

function requestClose(runtime, generation = 1, sender = {
  id: "tex-for-gmail-test",
  url: "chrome-extension://test/src/chrome-offscreen.html"
}) {
  const listener = runtime.onMessage.listeners[1];
  return new Promise(resolve => {
    const result = listener({
      generation,
      type: "tex-for-gmail:close-idle-renderer"
    }, sender, resolve);
    if (result === undefined)
      resolve(undefined);
    else
      assert.equal(result, true);
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
    justification: "Render local MathJax SVG output into a PNG image.",
    reasons: ["BLOBS"],
    url: "src/chrome-offscreen.html"
  });
  resolveCreation();

  assert.deepEqual({ ...await first }, { ok: true });
  assert.deepEqual({ ...await second }, { ok: true });
  assert.deepEqual(runtime.imports, ["controller.js"]);
  assert.equal(runtime.getContextsCalls(), 1);
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

test("Chrome service worker does not register legacy extension UI", () => {
  const runtime = loadChromeServiceWorker();

  assert.equal("commands" in runtime.chrome, false);
  assert.equal("contextMenus" in runtime.chrome, false);
  assert.equal("tabs" in runtime.chrome, false);
});

test("Chrome closes the renderer only for its authenticated idle message", async () => {
  const runtime = loadChromeServiceWorker();
  const listener = runtime.onMessage.listeners[1];
  const message = {
    generation: 1,
    type: "tex-for-gmail:close-idle-renderer"
  };
  const ownOffscreenDocument = {
    id: "tex-for-gmail-test",
    url: "chrome-extension://test/src/chrome-offscreen.html"
  };

  assert.equal(listener({ type: "other" }, ownOffscreenDocument), undefined);
  assert.equal(listener(message, {
    ...ownOffscreenDocument,
    id: "another-extension"
  }), undefined);
  assert.equal(listener(message, {
    ...ownOffscreenDocument,
    url: "chrome-extension://test/src/background.html"
  }), undefined);
  let invalidResponse;
  assert.equal(listener({
    generation: -1,
    type: "tex-for-gmail:close-idle-renderer"
  }, ownOffscreenDocument, value => {
    invalidResponse = value;
  }), false);
  assert.deepEqual({ ...invalidResponse }, { ok: false });
  assert.deepEqual(
    { ...await requestClose(runtime, 1, ownOffscreenDocument) },
    { ok: true }
  );
  assert.equal(runtime.closeCalls.length, 1);
  assert.deepEqual(runtime.sentMessages.map(message => ({ ...message })), [{
    generation: 1,
    type: "tex-for-gmail:prepare-idle-renderer-close"
  }]);
});

test("Chrome can retry cleanup after closing the renderer fails", async () => {
  let attempt = 0;
  const runtime = loadChromeServiceWorker({
    closeDocument() {
      attempt++;
      return attempt === 1
        ? Promise.reject(new Error("offscreen close failed"))
        : Promise.resolve();
    }
  });
  const sender = {
    id: "tex-for-gmail-test",
    url: "chrome-extension://test/src/chrome-offscreen.html"
  };

  assert.deepEqual({ ...await requestClose(runtime, 1, sender) }, {
    error: "offscreen close failed",
    ok: false
  });
  assert.deepEqual({ ...await requestClose(runtime, 1, sender) }, {
    ok: true
  });

  assert.equal(runtime.closeCalls.length, 2);
  assert.deepEqual(runtime.warnings, ["offscreen close failed"]);
  assert.deepEqual(runtime.sentMessages.map(message => message.type), [
    "tex-for-gmail:prepare-idle-renderer-close",
    "tex-for-gmail:cancel-idle-renderer-close",
    "tex-for-gmail:prepare-idle-renderer-close"
  ]);
});

test("Chrome reports both close and cancellation transport failures", async () => {
  const runtime = loadChromeServiceWorker({
    closeDocument() {
      return Promise.reject(new Error("offscreen close failed"));
    },
    sendMessage(message) {
      if (message.type === "tex-for-gmail:cancel-idle-renderer-close")
        return Promise.reject(new Error("close cancellation failed"));
      return Promise.resolve({ ok: true });
    }
  });

  assert.deepEqual({ ...await requestClose(runtime) }, {
    error: "offscreen close failed",
    ok: false
  });
  assert.deepEqual(runtime.warnings, [
    "close cancellation failed",
    "offscreen close failed"
  ]);
});

test("Chrome skips closing when the offscreen generation is no longer idle", async () => {
  const runtime = loadChromeServiceWorker({
    prepareResult: { ok: false }
  });

  assert.deepEqual({ ...await requestClose(runtime) }, {
    ok: false
  });
  assert.equal(runtime.closeCalls.length, 0);
});

test("Chrome serializes renderer creation behind an in-progress close", async () => {
  let releaseClose;
  const runtime = loadChromeServiceWorker({
    closeDocument() {
      return new Promise(resolve => {
        releaseClose = resolve;
      });
    }
  });

  const closing = requestClose(runtime);
  await new Promise(resolve => setImmediate(resolve));
  const ensuring = requestRenderer(runtime);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.createCalls.length, 0);

  releaseClose();
  assert.deepEqual({ ...await closing }, { ok: true });
  assert.deepEqual({ ...await ensuring }, { ok: true });
  assert.equal(runtime.createCalls.length, 1);
});
