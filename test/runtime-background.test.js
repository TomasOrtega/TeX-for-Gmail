"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PNG_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10
]);

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

function loadBackground(options = {}) {
  const canvases = [];
  const communicators = [];
  const hosts = [];
  const mathJaxConfigs = [];
  const runtimeMessages = [];
  const renderCalls = [];
  const revokedUrls = [];
  const scripts = [];
  const timers = [];
  const warnings = [];
  const onConnect = createEvent();
  const onMessage = createEvent();
  let scriptAttempt = 0;
  let resetCount = 0;
  let imageAttempt = 0;
  let context;

  class FakeCommunicator {
    static get SUCCESS() {
      return "1";
    }

    constructor(target) {
      this.messageHandler = {};
      this.target = target;
      communicators.push(this);
    }
  }

  class FakeElement {
    constructor(tagName) {
      this.attributes = {};
      this.children = [];
      this.listeners = new Map();
      this.style = {};
      this.tagName = tagName.toUpperCase();
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    append(child) {
      this.children.push(child);
    }

    remove() {
      this.removed = true;
    }

    setAttribute(name, value) {
      this.attributes[name] = value;
    }
  }

  function createSvg() {
    const svg = new FakeElement("svg");
    svg.getBoundingClientRect = () => ({
      height: options.svgHeight ?? 50,
      width: options.svgWidth ?? 100
    });
    return svg;
  }

  function createContainer() {
    const svg = options.noSvg ? undefined : createSvg();
    return {
      querySelector(selector) {
        assert.equal(selector, "svg");
        return svg;
      },
      svg
    };
  }

  function mathJaxRuntime(outcome) {
    if (outcome === "invalid") {
      return {
        startup: {
          promise: Promise.resolve()
        }
      };
    }

    const runtime = {
      startup: {
        promise: outcome === "startup-error"
          ? Promise.reject(new Error("MathJax startup failed"))
          : Promise.resolve()
      },
      tex2svgPromise(source, settings) {
        renderCalls.push({ settings, source });
        if (options.renderPromise)
          return Promise.resolve(options.renderPromise(source, settings))
            .then(container => container || createContainer());
        if (options.renderError)
          return Promise.reject(options.renderError);
        return Promise.resolve(createContainer());
      }
    };
    if (!options.omitTexReset) {
      runtime.texReset = () => {
        resetCount++;
      };
    }
    return runtime;
  }

  const document = {
    body: {
      append(host) {
        hosts.push(host);
      }
    },
    createElement(tagName) {
      if (tagName === "canvas") {
        const canvas = new FakeElement("canvas");
        const drawing = {
          drawImage(...parameters) {
            canvas.drawParameters = parameters;
          },
          fillRect(...parameters) {
            canvas.fillParameters = parameters;
          },
          fillStyle: ""
        };
        canvas.getContext = () => options.noCanvasContext ? null : drawing;
        canvas.toBlob = callback => {
          if (options.nullCanvasBlob) {
            callback(null);
            return;
          }
          if (options.canvasBlob)
            callback(options.canvasBlob);
          else
            callback(new Blob([options.pngBytes || PNG_BYTES]));
        };
        canvas.drawing = drawing;
        canvases.push(canvas);
        return canvas;
      }
      return new FakeElement(tagName);
    },
    head: {
      append(script) {
        scripts.push(script);
        const outcome = options.scriptOutcomes?.[scriptAttempt++] || "load";
        queueMicrotask(() => {
          if (outcome === "error") {
            script.listeners.get("error")();
            return;
          }
          mathJaxConfigs.push(context.MathJax);
          context.MathJax = mathJaxRuntime(outcome);
          script.listeners.get("load")();
        });
      }
    }
  };

  class FakeImage {
    constructor() {
      this.listeners = new Map();
      this.naturalHeight = options.imageHeight ?? 50;
      this.naturalWidth = options.imageWidth ?? 100;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    set src(value) {
      this.source = value;
      const outcome = options.imageOutcomes?.[imageAttempt++] ||
        (options.imageError ? "error" : "load");
      queueMicrotask(() => this.listeners.get(outcome)());
    }
  }

  const chrome = {
    runtime: {
      id: "tex-for-gmail-test",
      getURL(filename) {
        return `moz-extension://test/${filename}`;
      },
      lastError: null,
      onConnect,
      onMessage,
      sendMessage(message) {
        runtimeMessages.push(message);
        if (options.runtimeMessageError)
          return Promise.reject(options.runtimeMessageError);
        return Promise.resolve();
      }
    }
  };
  if (!options.runtimeGetManifestUnavailable) {
    chrome.runtime.getManifest = function () {
      return { manifest_version: options.manifestVersion || 2 };
    };
  }

  context = vm.createContext({
    ArrayBuffer,
    Blob,
    Communicator: FakeCommunicator,
    console: {
      log() {},
      warn(value) {
        warnings.push(value);
      }
    },
    chrome,
    clearTimeout(timer) {
      timer.cleared = true;
    },
    document,
    Image: FakeImage,
    location: (() => {
      const pathname = options.locationPath ||
        (options.manifestVersion === 3
          ? "/src/chrome-offscreen.html"
          : "/src/background.html");
      return {
        href: options.locationHref || `moz-extension://test${pathname}`,
        pathname
      };
    })(),
    Number,
    Object,
    PortWrapper: class {
      constructor(target) {
        this.target = target;
      }
    },
    Promise,
    queueMicrotask,
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    String,
    Uint8Array,
    URL: {
      createObjectURL() {
        return "blob:mathjax-svg";
      },
      revokeObjectURL(url) {
        revokedUrls.push(url);
      }
    },
    XMLSerializer: class {
      serializeToString(svg) {
        if (options.svgSource !== undefined)
          return options.svgSource;
        return `<svg width="${svg.attributes.width}"></svg>`;
      }
    },
    btoa(binary) {
      return Buffer.from(binary, "binary").toString("base64");
    }
  });

  const runtimeScripts = options.loadController === false
    ? ["background.js"]
    : ["background.js", "controller.js"];
  for (const filename of runtimeScripts) {
    vm.runInContext(
      fs.readFileSync(sourcePath(filename), "utf8"),
      context,
      { filename: sourcePath(filename) }
    );
  }

  const api = vm.runInContext(`({
    base64Encode,
    canvasPng,
    compile2pngDataURL,
    loadMathJax,
    loadSvgImage,
    measureSvg,
    rasterizeSvg,
    renderSvg,
    requireAlpha,
    requireDimensions,
    requirePngFile,
    requireScale,
    requireSource,
    validateRenderRequest,
    withRenderTimeout
  })`, context);

  return {
    api,
    canvases,
    chrome,
    communicators,
    context,
    hosts,
    mathJaxConfigs,
    onConnect,
    onMessage,
    renderCalls,
    resetCount: () => resetCount,
    revokedUrls,
    runtimeMessages,
    scripts,
    timers,
    warnings
  };
}

test("background renders validated MathJax SVG output as a PNG data URL", async () => {
  const runtime = loadBackground();
  const response = await runtime.api.compile2pngDataURL({
    alpha: 0,
    display: true,
    scale: 2,
    source: String.raw`\boldsymbol{x}`
  });

  assert.deepEqual({
    ...response,
    payload: { ...response.payload }
  }, {
    code: "1",
    payload: {
      dataUrl: "data:image/png;base64,iVBORw0KGgo="
    }
  });
  assert.equal(runtime.scripts.length, 1);
  assert.equal(
    runtime.scripts[0].src,
    "moz-extension://test/resources/mathjax/tex-svg.js"
  );
  assert.equal(runtime.scripts[0].async, true);
  assert.deepEqual(
    [...runtime.mathJaxConfigs[0].loader.load],
    ["[tex]/begingroup", "[tex]/boldsymbol"]
  );
  assert.equal(
    runtime.mathJaxConfigs[0].loader.paths.fonts,
    "moz-extension://test/resources/mathjax"
  );
  assert.equal(
    runtime.mathJaxConfigs[0].tex.maxTemplateSubtitutions,
    10000
  );
  assert.equal(
    runtime.mathJaxConfigs[0].tex.maxTemplateSubstitutions,
    undefined
  );
  assert.deepEqual(runtime.renderCalls.map(call => ({
    display: call.settings.display,
    source: call.source
  })), [{
    display: true,
    source: String.raw`\begingroupSandbox
\boldsymbol{x}`
  }]);
  assert.equal(runtime.resetCount(), 1);
  assert.deepEqual(runtime.hosts[0].children[0].svg.attributes, {
    color: "#000",
    height: "50px",
    width: "100px",
    xmlns: "http://www.w3.org/2000/svg"
  });
  assert.equal(runtime.hosts[0].removed, true);
  assert.equal(runtime.canvases[0].width, 212);
  assert.equal(runtime.canvases[0].height, 112);
  assert.equal(runtime.canvases[0].drawing.fillStyle, "#fff");
  assert.deepEqual(runtime.canvases[0].fillParameters, [0, 0, 212, 112]);
  assert.deepEqual(runtime.canvases[0].drawParameters.slice(1), [
    6, 6, 200, 100
  ]);
  assert.deepEqual(runtime.revokedUrls, ["blob:mathjax-svg"]);
  assert.equal(runtime.timers[0].delay, 15000);
  assert.equal(runtime.timers[0].cleared, true);

  await runtime.api.compile2pngDataURL({
    alpha: 1,
    display: false,
    scale: 1,
    source: "y"
  });
  assert.equal(runtime.scripts.length, 1);
  assert.equal(runtime.resetCount(), 2);
  assert.equal(runtime.canvases[1].fillParameters, undefined);
  assert.equal(
    runtime.timers.some(timer => timer.delay === 5 * 60 * 1000),
    false
  );
});

test("Chrome offscreen renderer starts without runtime.getManifest", () => {
  const runtime = loadBackground({
    loadController: false,
    manifestVersion: 3,
    runtimeGetManifestUnavailable: true
  });

  assert.equal(runtime.onConnect.listeners.length, 1);
  assert.equal(runtime.onMessage.listeners.length, 1);
});

test("Chrome background closes only after every render has been idle", async () => {
  const releases = [];
  const runtime = loadBackground({
    manifestVersion: 3,
    renderPromise() {
      return new Promise(resolve => releases.push(resolve));
    }
  });
  const request = source => runtime.api.compile2pngDataURL({
    alpha: 1,
    display: false,
    scale: 1,
    source
  });

  const first = request("x");
  const second = request("y");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases.shift()();
  await first;
  assert.equal(
    runtime.timers.some(timer => timer.delay === 5 * 60 * 1000),
    false
  );

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases.shift()();
  await second;
  const firstIdle = runtime.timers.find(
    timer => timer.delay === 5 * 60 * 1000
  );
  assert.ok(firstIdle);
  assert.deepEqual(runtime.runtimeMessages, []);

  const third = request("z");
  assert.equal(firstIdle.cleared, true);
  firstIdle.callback();
  assert.deepEqual(runtime.runtimeMessages, []);

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases.shift()();
  await third;
  const idleTimers = runtime.timers.filter(
    timer => timer.delay === 5 * 60 * 1000
  );
  assert.equal(idleTimers.length, 2);
  idleTimers[1].callback();
  assert.deepEqual(runtime.runtimeMessages.map(message => ({ ...message })), [{
    generation: 3,
    type: "tex-for-gmail:close-idle-renderer"
  }]);
});

test("Chrome background schedules cleanup after a failed render", async () => {
  const runtime = loadBackground({
    manifestVersion: 3,
    renderError: new Error("formula rejected")
  });

  await assert.rejects(
    runtime.api.compile2pngDataURL({
      alpha: 1,
      display: false,
      scale: 1,
      source: "x"
    }),
    /formula rejected/i
  );
  const idle = runtime.timers.find(
    timer => timer.delay === 5 * 60 * 1000
  );
  assert.ok(idle);
  idle.callback();
  await Promise.resolve();
  assert.deepEqual(runtime.runtimeMessages.map(message => ({ ...message })), [{
    generation: 1,
    type: "tex-for-gmail:close-idle-renderer"
  }]);
});

test("Chrome background stays active while a timed-out render is still running", async () => {
  let release;
  const runtime = loadBackground({
    manifestVersion: 3,
    renderPromise() {
      return new Promise(resolve => {
        release = resolve;
      });
    }
  });
  const render = runtime.api.compile2pngDataURL({
    alpha: 1,
    display: false,
    scale: 1,
    source: "x"
  });
  await new Promise(resolve => setImmediate(resolve));

  const timeout = runtime.timers.find(timer => timer.delay === 15000);
  assert.ok(timeout);
  timeout.callback();
  await assert.rejects(render, /timed out/i);
  assert.equal(
    runtime.timers.some(timer => timer.delay === 5 * 60 * 1000),
    false
  );

  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    runtime.timers.some(timer => timer.delay === 5 * 60 * 1000),
    true
  );
});

test("Chrome background confirms an idle generation before closing", async () => {
  const runtime = loadBackground({ manifestVersion: 3 });
  const request = {
    alpha: 1,
    display: false,
    scale: 1,
    source: "x"
  };
  await runtime.api.compile2pngDataURL(request);
  const idle = runtime.timers.find(
    timer => timer.delay === 5 * 60 * 1000
  );

  const control = runtime.onMessage.listeners[0];
  const sender = {
    id: "tex-for-gmail-test",
    url: "moz-extension://test/src/chrome-service-worker.js"
  };
  let response;
  assert.equal(control({
    generation: 1,
    type: "tex-for-gmail:prepare-idle-renderer-close"
  }, sender, value => {
    response = value;
  }), false);
  assert.deepEqual({ ...response }, { ok: true });
  assert.equal(idle.cleared, true);

  await assert.rejects(
    runtime.api.compile2pngDataURL(request),
    /renderer is restarting/i
  );

  assert.equal(control({
    generation: 1,
    type: "tex-for-gmail:cancel-idle-renderer-close"
  }, sender, value => {
    response = value;
  }), false);
  assert.deepEqual({ ...response }, { ok: true });
  await runtime.api.compile2pngDataURL(request);
});

test("Chrome background accepts a service worker sender without a URL", () => {
  const runtime = loadBackground({ manifestVersion: 3 });
  const control = runtime.onMessage.listeners[0];
  let response;

  assert.equal(control({
    generation: 0,
    type: "tex-for-gmail:prepare-idle-renderer-close"
  }, {
    id: "tex-for-gmail-test"
  }, value => {
    response = value;
  }), false);
  assert.deepEqual({ ...response }, { ok: true });
});

test("Chrome background refuses stale or unauthenticated close preparation", async () => {
  let release;
  const runtime = loadBackground({
    manifestVersion: 3,
    renderPromise() {
      return new Promise(resolve => {
        release = resolve;
      });
    }
  });
  const control = runtime.onMessage.listeners[0];
  const sender = {
    id: "tex-for-gmail-test",
    url: "moz-extension://test/src/chrome-service-worker.js"
  };
  let response;

  assert.equal(control({
    generation: -1,
    type: "tex-for-gmail:prepare-idle-renderer-close"
  }, sender, value => {
    response = value;
  }), false);
  assert.deepEqual({ ...response }, { ok: false });

  assert.equal(control({
    generation: 0,
    type: "tex-for-gmail:prepare-idle-renderer-close"
  }, {
    ...sender,
    id: "another-extension"
  }, () => {}), undefined);
  assert.equal(control({
    generation: 0,
    type: "tex-for-gmail:prepare-idle-renderer-close"
  }, {
    ...sender,
    url: "moz-extension://test/src/background.html"
  }, () => {}), undefined);
  assert.equal(control({
    generation: 0,
    type: "tex-for-gmail:prepare-idle-renderer-close"
  }, {
    id: sender.id,
    tab: { id: 7 }
  }, () => {}), undefined);

  const render = runtime.api.compile2pngDataURL({
    alpha: 1,
    display: false,
    scale: 1,
    source: "x"
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(control({
    generation: 0,
    type: "tex-for-gmail:prepare-idle-renderer-close"
  }, sender, value => {
    response = value;
  }), false);
  assert.deepEqual({ ...response }, { ok: false });
  release();
  await render;
});

test("background validates every untrusted render field", () => {
  const runtime = loadBackground();
  const valid = {
    alpha: 1,
    display: false,
    scale: 2,
    source: "x"
  };

  assert.deepEqual({ ...runtime.api.validateRenderRequest(valid) }, valid);
  for (const request of [
    null,
    [],
    { ...valid, extra: true },
    { ...valid, display: "false" }
  ])
    assert.throws(() => runtime.api.validateRenderRequest(request));

  for (const source of [undefined, "", "  "])
    assert.throws(() => runtime.api.requireSource(source), /non-empty/i);
  assert.throws(
    () => runtime.api.requireSource("x".repeat(20001)),
    /too long/i
  );
  assert.throws(() => runtime.api.requireSource("x\0y"), /null/i);
  assert.equal(runtime.api.requireSource(" x "), " x ");

  for (const scale of [NaN, 0.49, 4.01])
    assert.throws(() => runtime.api.requireScale(scale), /scale/i);
  assert.equal(runtime.api.requireScale(0.5), 0.5);
  assert.equal(runtime.api.requireScale(4), 4);

  for (const alpha of [-1, false, 2])
    assert.throws(() => runtime.api.requireAlpha(alpha), /alpha/i);
  assert.equal(runtime.api.requireAlpha(0), 0);

  for (const dimensions of [
    [NaN, 1],
    [1, Infinity],
    [0, 1],
    [1, 0],
    [4097, 1],
    [1, 4097]
  ])
    assert.throws(() => runtime.api.requireDimensions(...dimensions));
  assert.deepEqual(
    { ...runtime.api.requireDimensions(100, 50) },
    { height: 50, width: 100 }
  );
});

test("background rejects malformed or oversized PNG output", () => {
  const runtime = loadBackground();
  assert.throws(() => runtime.api.requirePngFile(new Uint8Array(PNG_BYTES)));
  assert.throws(() => runtime.api.requirePngFile(new ArrayBuffer(7)), /size/i);
  assert.throws(
    () => runtime.api.requirePngFile(new ArrayBuffer(8 * 1024 * 1024 + 1)),
    /size/i
  );
  assert.throws(
    () => runtime.api.requirePngFile(new Uint8Array(8).buffer),
    /signature/i
  );
  assert.equal(
    runtime.api.requirePngFile(PNG_BYTES.slice().buffer).byteLength,
    8
  );
});

test("background resets failed MathJax loads so a later render can retry", async () => {
  const scriptFailure = loadBackground({
    scriptOutcomes: ["error", "load"]
  });
  await assert.rejects(
    scriptFailure.api.loadMathJax(),
    /could not be loaded/i
  );
  await scriptFailure.api.loadMathJax();
  assert.equal(scriptFailure.scripts.length, 2);

  const startupFailure = loadBackground({
    scriptOutcomes: ["startup-error", "load"]
  });
  await assert.rejects(startupFailure.api.loadMathJax(), /startup failed/i);
  await startupFailure.api.loadMathJax();
  assert.equal(startupFailure.scripts.length, 2);

  const invalid = loadBackground({
    scriptOutcomes: ["invalid", "load"]
  });
  await assert.rejects(invalid.api.loadMathJax(), /invalid/i);
  await invalid.api.loadMathJax();
  assert.equal(invalid.scripts.length, 2);
});

test("background measures SVG safely and always removes its temporary host", () => {
  const missing = loadBackground({ noSvg: true });
  assert.throws(
    () => missing.api.measureSvg({
      querySelector() {
        return undefined;
      }
    }),
    /did not produce/i
  );
  assert.equal(missing.hosts[0].removed, true);

  const invalidBounds = loadBackground({ svgWidth: 0 });
  assert.throws(
    () => invalidBounds.api.measureSvg({
      querySelector() {
        return {
          getBoundingClientRect() {
            return { height: 10, width: 0 };
          }
        };
      }
    }),
    /dimensions/i
  );
  assert.equal(invalidBounds.hosts[0].removed, true);

  const oversized = loadBackground({
    svgSource: "x".repeat(4 * 1024 * 1024 + 1)
  });
  assert.throws(
    () => oversized.api.measureSvg({
      querySelector() {
        const svg = {
          attributes: {},
          getBoundingClientRect() {
            return { height: 10, width: 10 };
          },
          setAttribute(name, value) {
            this.attributes[name] = value;
          }
        };
        return svg;
      }
    }),
    /SVG exceeds/i
  );
  assert.equal(oversized.hosts[0].removed, true);
});

test("background handles SVG image and canvas failures", async () => {
  const imageFailure = loadBackground({ imageError: true });
  await assert.rejects(
    imageFailure.api.loadSvgImage("<svg></svg>"),
    /could not be loaded/i
  );
  assert.deepEqual(imageFailure.revokedUrls, ["blob:mathjax-svg"]);

  const invalidImage = loadBackground({ imageWidth: 0 });
  await assert.rejects(
    invalidImage.api.rasterizeSvg("<svg></svg>", 1, 1),
    /dimensions/i
  );

  const paddedTooLarge = loadBackground({ imageWidth: 4091 });
  await assert.rejects(
    paddedTooLarge.api.rasterizeSvg("<svg></svg>", 1, 1),
    /dimensions/i
  );

  const noContext = loadBackground({ noCanvasContext: true });
  await assert.rejects(
    noContext.api.rasterizeSvg("<svg></svg>", 1, 1),
    /Canvas rendering is unavailable/i
  );

  const noBlob = loadBackground({ nullCanvasBlob: true });
  await assert.rejects(
    noBlob.api.rasterizeSvg("<svg></svg>", 1, 1),
    /could not be encoded/i
  );

  const blobFailure = loadBackground({
    canvasBlob: {
      arrayBuffer() {
        return Promise.reject(new Error("blob read failed"));
      }
    }
  });
  await assert.rejects(
    blobFailure.api.rasterizeSvg("<svg></svg>", 1, 1),
    /blob read failed/i
  );

  const invalidPng = loadBackground({
    pngBytes: new Uint8Array(8)
  });
  await assert.rejects(
    invalidPng.api.rasterizeSvg("<svg></svg>", 1, 1),
    /invalid signature/i
  );
});

test("background propagates MathJax failures and enforces its deadline", async () => {
  const renderingFailure = loadBackground({
    omitTexReset: true,
    renderError: new Error("formula rejected")
  });
  await assert.rejects(
    renderingFailure.api.renderSvg("x", false),
    /formula rejected/i
  );
  assert.equal(renderingFailure.resetCount(), 0);

  const pending = loadBackground({
    renderPromise() {
      return new Promise(() => {});
    }
  });
  const compilation = pending.api.compile2pngDataURL({
    alpha: 1,
    display: false,
    scale: 1,
    source: "x"
  });
  await Promise.resolve();
  pending.timers[0].callback();
  await assert.rejects(compilation, /timed out/i);
  assert.equal(pending.timers[0].cleared, true);
});

test("background base64 encoding preserves large typed-array views", () => {
  const runtime = loadBackground();
  const source = new Uint8Array(70010);
  source.fill(0xff);
  source[5] = 0;
  source[70004] = 1;
  const decoded = Buffer.from(
    runtime.api.base64Encode(source.subarray(5, 70005)),
    "base64"
  );

  assert.equal(decoded.length, 70000);
  assert.equal(decoded[0], 0);
  assert.equal(decoded[1], 0xff);
  assert.equal(decoded.at(-1), 1);
});

test("background accepts only Gmail extension ports", () => {
  const runtime = loadBackground();
  let disconnected = false;
  runtime.onConnect.listeners[0]({
    disconnect() {
      disconnected = true;
    },
    sender: {
      url: "https://example.com/"
    }
  });
  assert.equal(disconnected, true);

  const onDisconnect = createEvent();
  const port = {
    onDisconnect,
    sender: {
      tab: {
        url: "https://mail.google.com/mail/u/0/#inbox"
      }
    }
  };
  runtime.onConnect.listeners[0](port);
  assert.deepEqual(
    Object.keys(runtime.communicators[0].messageHandler),
    ["compile2pngDataURL"]
  );
  assert.equal(vm.runInContext("ports.size", runtime.context), 1);
  onDisconnect.listeners[0]();
  assert.equal(vm.runInContext("ports.size", runtime.context), 0);
});

test("controller registers no extension-action, context-menu, or shortcut UI", () => {
  const runtime = loadBackground();

  assert.equal("commands" in runtime.chrome, false);
  assert.equal("contextMenus" in runtime.chrome, false);
  assert.equal("tabs" in runtime.chrome, false);
});

test("Firefox controller restricts renderer bootstrap to Gmail", async () => {
  const runtime = loadBackground();
  const listener = runtime.onMessage.listeners[0];
  let response;

  assert.equal(listener({ type: "other" }, {}, () => {}), undefined);
  assert.equal(listener(
    { type: "tex-for-gmail:ensure-renderer" },
    { url: "https://example.com/" },
    value => {
      response = value;
    }
  ), false);
  assert.deepEqual({ ...response }, {
    error: "Renderer initialization is restricted to Gmail.",
    ok: false
  });

  assert.equal(listener(
    { type: "tex-for-gmail:ensure-renderer" },
    { url: "https://mail.google.com/" },
    value => {
      response = value;
    }
  ), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual({ ...response }, { ok: true });
});
