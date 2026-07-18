"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const latex = require("../chrome-extension/src/latex.js");

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function loadContent(options = {}) {
  let statusElement;
  const documentListeners = new Map();
  const requests = [];
  const bootstrapMessages = [];
  const inserted = [];
  const editorEvents = [];
  const runtimeMessages = createEvent();
  const disconnect = createEvent();
  const timers = [];
  let connectCount = 0;

  class FakeElement {
    constructor(tagName = "div") {
      this.attributes = {};
      this.dataset = {};
      this.isConnected = true;
      this.nodeType = 1;
      this.tagName = tagName.toUpperCase();
      this.textContent = "";
    }

    append() {}

    closest(selector) {
      if (selector === '[contenteditable="true"]' && this.isEditor)
        return this;
      return undefined;
    }

    dispatchEvent(event) {
      editorEvents.push(event);
      return true;
    }

    remove() {
      this.isConnected = false;
      if (statusElement === this)
        statusElement = undefined;
    }

    setAttribute(name, value) {
      this.attributes[name] = value;
    }
  }

  const editor = new FakeElement("div");
  editor.isEditor = true;
  const range = {
    collapsed: false,
    commonAncestorContainer: editor,
    cloneRange() {
      return this;
    },
    collapse(value) {
      this.collapsed = value;
    },
    deleteContents() {
      this.deleted = true;
    },
    insertNode(node) {
      inserted.push(node);
    },
    setStartAfter(node) {
      this.startedAfter = node;
    },
    toString() {
      return options.selectedText || "$x^2$";
    }
  };
  const selection = {
    rangeCount: options.noSelection ? 0 : 1,
    currentRange: range,
    addRange(nextRange) {
      this.currentRange = nextRange;
      this.rangeCount = 1;
    },
    getRangeAt() {
      return this.currentRange;
    },
    removeAllRanges() {
      this.rangeCount = 0;
    }
  };

  class FakeImage extends FakeElement {
    constructor() {
      super("img");
      this.listeners = new Map();
      this.naturalHeight = options.imageHeight ?? 100;
      this.naturalWidth = options.imageWidth ?? 200;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    get outerHTML() {
      return `<img alt="${this.alt}">`;
    }

    set src(value) {
      this.source = value;
      queueMicrotask(() => {
        const event = options.imageError ? "error" : "load";
        this.listeners.get(event)?.();
      });
    }
  }

  const document = {
    documentElement: {
      append(element) {
        statusElement = element;
      }
    },
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    execCommand(command, _showUi, html) {
      this.lastCommand = { command, html };
      return options.execCommandResult ?? false;
    },
    querySelector(selector) {
      if (selector === "#tex-for-gmail-status")
        return statusElement;
      return undefined;
    }
  };

  const port = {
    onDisconnect: disconnect
  };
  class FakeCommunicator {
    request(command, params) {
      requests.push({ command, params });
      if (options.request)
        return options.request(command, params);
      return Promise.resolve({
        dataUrl: "data:image/png;base64,iVBORw0KGgo="
      });
    }
  }

  const browser = {
    runtime: {
      connect() {
        connectCount++;
        return port;
      },
      async sendMessage(message) {
        bootstrapMessages.push(message);
        if (options.bootstrapError)
          throw options.bootstrapError;
        return options.bootstrapResult || { ok: true };
      },
      onMessage: runtimeMessages
    }
  };
  const context = vm.createContext({
    atob: options.atob || atob,
    clearTimeout() {},
    Communicator: FakeCommunicator,
    document,
    globalThis: {},
    Image: FakeImage,
    InputEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    Node: {
      ELEMENT_NODE: 1
    },
    PortWrapper: class {
      constructor(target) {
        this.target = target;
      }
    },
    Promise,
    queueMicrotask,
    random_id() {
      return "content-test";
    },
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    TeXForGmail: latex,
    window: {
      getSelection() {
        return selection;
      }
    },
    browser
  });
  context.globalThis = context;

  const filename = path.join(
    __dirname,
    "..",
    "chrome-extension",
    "src",
    "contentscr.js"
  );
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });

  const rawMessageListener = runtimeMessages.listeners[0];
  return {
    api: vm.runInContext(
      "({ insertImage, loadImage, messageForError, renderLatex, requirePngDataUrl })",
      context
    ),
    bootstrapMessages,
    connectCount: () => connectCount,
    disconnect,
    document,
    editorEvents,
    inserted,
    messageListener(message, sender = {
      url: "https://mail.google.com/mail/u/0/#inbox"
    }) {
      return new Promise((resolve, reject) => {
        const result = rawMessageListener(message, sender, resolve);
        if (result === undefined)
          resolve(undefined);
        else if (result !== true)
          Promise.resolve(result).then(resolve, reject);
      });
    },
    range,
    requests,
    selection,
    status: () => statusElement,
    timers
  };
}

test("content script compiles and inserts selected LaTeX", async () => {
  const runtime = loadContent();

  const result = await runtime.messageListener({
    type: "tex-for-gmail:render"
  });

  assert.deepEqual({ ...result }, { ok: true });
  assert.equal(runtime.requests.length, 1);
  assert.equal(runtime.requests[0].command, "compile2pngDataURL");
  assert.match(runtime.requests[0].params.srcCode, /\\\(x\^2\\\)/);
  assert.equal(runtime.requests[0].params.scale, 2);
  assert.equal(runtime.requests[0].params.alpha, 1);
  assert.deepEqual(
    runtime.bootstrapMessages.map(message => ({ ...message })),
    [{ type: "tex-for-gmail:ensure-renderer" }]
  );
  assert.equal(runtime.inserted.length, 1);
  assert.equal(runtime.range.deleted, true);
  assert.equal(runtime.editorEvents[0].type, "input");
  assert.equal(runtime.status().textContent, "LaTeX inserted.");
  assert.equal(runtime.status().dataset.state, "success");
  runtime.timers.at(-1).callback();
  assert.equal(runtime.status(), undefined);

  runtime.disconnect.listeners[0]();
  assert.deepEqual(
    { ...await runtime.api.renderLatex({ latex: "$y$" }) },
    { ok: true }
  );
  assert.equal(runtime.connectCount(), 2);
});

test("content script reports invalid messages and missing compose selections", async () => {
  const runtime = loadContent({ noSelection: true });

  assert.equal(
    await runtime.messageListener({ type: "unrelated" }),
    undefined
  );
  assert.deepEqual(
    {
      ...await runtime.messageListener({
      display: "yes",
      latex: 42,
      type: "tex-for-gmail:render"
      })
    },
    {
      error: "Malformed LaTeX render request.",
      ok: false
    }
  );

  const result = await runtime.messageListener({
    latex: "$x$",
    type: "tex-for-gmail:render"
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /cursor/i);
  assert.equal(runtime.status().dataset.state, "error");
  assert.equal(runtime.timers.at(-1).delay, 6000);
});

test("content script bounds image output and source metadata", async () => {
  const oversized = loadContent({ imageWidth: 5000 });
  await assert.rejects(
    oversized.api.loadImage("data:image/png;base64,AA==", "$x$"),
    /dimensions/i
  );

  const longSource = loadContent();
  const image = await longSource.api.loadImage(
    "data:image/png;base64,AA==",
    "x".repeat(513)
  );
  assert.equal(image.alt, "Rendered LaTeX formula");

  const broken = loadContent({ imageError: true });
  await assert.rejects(
    broken.api.loadImage("data:image/png;base64,broken", "$x$"),
    /could not be loaded/i
  );
});

test("content script rejects overlapping renders and surfaces worker errors", async () => {
  let release;
  const deferred = new Promise(resolve => {
    release = resolve;
  });
  const runtime = loadContent({
    request() {
      return deferred;
    }
  });

  const first = runtime.api.renderLatex({ latex: "$x$" });
  await Promise.resolve();
  assert.deepEqual(
    {
      ...await runtime.api.renderLatex({ latex: "$y$" })
    },
    {
      error: "A LaTeX render is already in progress.",
      ok: false
    }
  );
  release({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" });
  assert.deepEqual({ ...await first }, { ok: true });

  const failure = loadContent({
    request() {
      return Promise.reject({ err: "Compilation failed." });
    }
  });
  const result = await failure.api.renderLatex({ latex: "$z$" });
  assert.deepEqual({ ...result }, {
    error: "Compilation failed.",
    ok: false
  });
  assert.equal(failure.api.messageForError({}), "LaTeX rendering failed.");
});

test("content script surfaces renderer bootstrap failures", async () => {
  const runtime = loadContent({
    bootstrapResult: {
      error: "Renderer host unavailable.",
      ok: false
    }
  });

  const result = await runtime.api.renderLatex({ latex: "$x$" });

  assert.deepEqual({ ...result }, {
    error: "Renderer host unavailable.",
    ok: false
  });
  assert.equal(runtime.connectCount(), 0);
});

test("content script rejects malformed PNG data URLs", async () => {
  const runtime = loadContent({
    request() {
      return Promise.resolve({
        dataUrl: "data:text/html;base64,iVBORw0KGgo="
      });
    }
  });
  const result = await runtime.api.renderLatex({ latex: "$x$" });
  assert.equal(result.ok, false);
  assert.match(result.error, /PNG data URL/i);

  assert.throws(
    () => runtime.api.requirePngDataUrl(
      "data:image/png;base64,AAAAAAAAAAA="
    ),
    /signature/i
  );
  assert.throws(
    () => runtime.api.requirePngDataUrl("data:image/png;base64,AA=="),
    /size/i
  );

  const decoderFailure = loadContent({
    atob() {
      throw new Error("decoder failed");
    }
  });
  assert.throws(
    () => decoderFailure.api.requirePngDataUrl(
      "data:image/png;base64,iVBORw0KGgo="
    ),
    /invalid PNG data URL/i
  );
});
