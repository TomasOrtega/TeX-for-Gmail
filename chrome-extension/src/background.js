"use strict";

console.log("TeX for Gmail renderer is ready.");

const MATHJAX_SCRIPT = "resources/mathjax/tex-svg.js";
const TEX_SANDBOX_PREFIX = "\\begingroupSandbox\n";
const MAX_SOURCE_LENGTH = 20000;
const MAX_SVG_LENGTH = 4 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_RASTER_DIMENSION = 4096;
const MAX_RASTER_PIXELS = 16 * 1024 * 1024;
const MIN_RENDER_SCALE = 0.5;
const MAX_RENDER_SCALE = 4;
const RENDER_PADDING_PX = 3;
const RENDER_TIMEOUT_MS = 15000;
const OFFSCREEN_IDLE_CLOSE_MS = 5 * 60 * 1000;
const OFFSCREEN_IDLE_CLOSE_MESSAGE =
  "tex-for-gmail:close-idle-renderer";
const OFFSCREEN_PREPARE_CLOSE_MESSAGE =
  "tex-for-gmail:prepare-idle-renderer-close";
const OFFSCREEN_CANCEL_CLOSE_MESSAGE =
  "tex-for-gmail:cancel-idle-renderer-close";
const OFFSCREEN_RESTART_MESSAGE =
  "tex-for-gmail:restart-renderer";
const CHROME_SERVICE_WORKER_PATH = "src/chrome-service-worker.js";
const RENDERER_RESTARTING_ERROR = "The renderer is restarting.";
const RENDER_QUEUE_TIMEOUT_ERROR =
  "LaTeX rendering queue timed out.";
const IS_CHROME_OFFSCREEN =
  globalThis.location?.href ===
    chrome.runtime.getURL("src/chrome-offscreen.html");
const ports = new Map();
let mathJaxPromise;
let renderQueue = Promise.resolve();
let scheduledRenders = 0;
let activeRenders = 0;
let idleCloseTimer;
let rendererClosing = false;
let rendererFailed = false;
let rendererGeneration = 0;
let closingGeneration;

class RenderTimeoutError extends Error {}

function requireSource(source) {
  if (typeof source !== "string" || !source.trim())
    throw new Error("LaTeX source must be a non-empty string.");
  if (source.length > MAX_SOURCE_LENGTH)
    throw new Error("LaTeX source is too long.");
  if (source.includes("\0"))
    throw new Error("LaTeX source contains an invalid null character.");
  return source;
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

function requireDimensions(width, height) {
  if (!Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 1 ||
      height < 1 ||
      width > MAX_RASTER_DIMENSION ||
      height > MAX_RASTER_DIMENSION ||
      width * height > MAX_RASTER_PIXELS)
    throw new Error("Rendered image dimensions exceed the safety limit.");
  return { height, width };
}

function requirePngFile(file) {
  if (!(file instanceof ArrayBuffer))
    throw new Error("PNG output must be an array buffer.");
  if (file.byteLength < 8 || file.byteLength > MAX_PNG_BYTES)
    throw new Error("PNG output exceeds the size limit or is empty.");

  const bytes = new Uint8Array(file);
  if (bytes[0] !== 0x89 ||
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

function validateRenderRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new Error("Malformed render request.");

  const allowed = new Set(["alpha", "display", "scale", "source"]);
  for (const key of Object.keys(request)) {
    if (!allowed.has(key))
      throw new Error(`Unexpected render option: ${key}.`);
  }
  if (typeof request.display !== "boolean")
    throw new Error("Display mode must be a boolean.");

  return {
    alpha: requireAlpha(request.alpha),
    display: request.display,
    scale: requireScale(request.scale),
    source: requireSource(request.source)
  };
}

function mathJaxConfig() {
  return {
    loader: {
      load: ["[tex]/begingroup", "[tex]/boldsymbol"],
      paths: {
        fonts: chrome.runtime.getURL("resources/mathjax")
      }
    },
    options: {
      enableEnrichment: false,
      enableExplorer: false,
      enableMenu: false,
      enableSpeech: false,
      menuOptions: {
        settings: {
          braille: false,
          enrich: false,
          speech: false
        }
      }
    },
    output: {
      linebreaks: {
        inline: false
      }
    },
    startup: {
      typeset: false
    },
    svg: {
      fontCache: "local"
    },
    tex: {
      maxBuffer: MAX_SOURCE_LENGTH + TEX_SANDBOX_PREFIX.length,
      maxTemplateSubtitutions: 10000,
      packages: [
        "base",
        "ams",
        "newcommand",
        "noundefined",
        "begingroup",
        "boldsymbol"
      ]
    }
  };
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = url;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => {
      reject(new Error("The packaged MathJax renderer could not be loaded."));
    }, { once: true });
    document.head.append(script);
  });
}

async function loadMathJax() {
  if (!mathJaxPromise) {
    globalThis.MathJax = mathJaxConfig();
    mathJaxPromise = loadScript(chrome.runtime.getURL(MATHJAX_SCRIPT))
      .then(() => globalThis.MathJax.startup.promise)
      .then(() => {
        if (typeof globalThis.MathJax.tex2svgPromise !== "function")
          throw new Error("The packaged MathJax renderer is invalid.");
        return globalThis.MathJax;
      })
      .catch(error => {
        mathJaxPromise = undefined;
        throw error;
      });
  }
  return mathJaxPromise;
}

function measureSvg(container) {
  const host = document.createElement("div");
  host.style.cssText =
    "position:absolute;left:-100000px;top:0;font-size:16px;color:#000";
  host.append(container);
  document.body.append(host);

  try {
    const svg = container.querySelector("svg");
    if (!svg)
      throw new Error("MathJax did not produce an SVG image.");
    const bounds = svg.getBoundingClientRect();
    requireDimensions(bounds.width, bounds.height);
    svg.setAttribute("color", "#000");
    svg.setAttribute("height", `${bounds.height}px`);
    svg.setAttribute("width", `${bounds.width}px`);
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const source = new XMLSerializer().serializeToString(svg);
    if (source.length > MAX_SVG_LENGTH)
      throw new Error("Rendered SVG exceeds the size limit.");
    return source;
  } finally {
    host.remove();
  }
}

async function renderSvg(source, display) {
  const mathJax = await loadMathJax();
  if (typeof mathJax.texReset === "function")
    mathJax.texReset();
  const container = await mathJax.tex2svgPromise(
    TEX_SANDBOX_PREFIX + source,
    {
      containerWidth: 1200,
      display,
      em: 16,
      ex: 8
    }
  );
  return measureSvg(container);
}

function loadSvgImage(source) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([source], {
      type: "image/svg+xml;charset=utf-8"
    }));
    const image = new Image();
    const cleanup = () => URL.revokeObjectURL(url);
    image.addEventListener("load", () => {
      cleanup();
      resolve(image);
    }, { once: true });
    image.addEventListener("error", () => {
      cleanup();
      reject(new Error("The rendered SVG image could not be loaded."));
    }, { once: true });
    image.src = url;
  });
}

function canvasPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error("The rendered image could not be encoded."));
        return;
      }
      blob.arrayBuffer().then(resolve, reject);
    }, "image/png");
  });
}

async function rasterizeSvg(source, scale, alpha) {
  const image = await loadSvgImage(source);
  requireDimensions(image.naturalWidth, image.naturalHeight);

  const padding = Math.ceil(RENDER_PADDING_PX * scale);
  const contentWidth = Math.ceil(image.naturalWidth * scale);
  const contentHeight = Math.ceil(image.naturalHeight * scale);
  const { width, height } = requireDimensions(
    contentWidth + padding * 2,
    contentHeight + padding * 2
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Canvas rendering is unavailable.");
  if (alpha === 0) {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(
    image,
    padding,
    padding,
    contentWidth,
    contentHeight
  );
  return requirePngFile(await canvasPng(canvas));
}

function withRenderTimeout(render) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RenderTimeoutError("LaTeX rendering timed out."));
    }, RENDER_TIMEOUT_MS);
  });
  const rendering = Promise.resolve().then(render);
  return Promise.race([rendering, timeout])
    .finally(() => clearTimeout(timer));
}

function enqueueRender(render) {
  const state = { cancelled: false, started: false };
  let queueTimer;
  let waiting;

  if (scheduledRenders > 0) {
    waiting = new Promise((_resolve, reject) => {
      queueTimer = setTimeout(() => {
        if (state.started)
          return;
        state.cancelled = true;
        reject(new Error(RENDER_QUEUE_TIMEOUT_ERROR));
      }, RENDER_TIMEOUT_MS);
    });
  }
  scheduledRenders++;

  const execute = () => {
    state.started = true;
    if (queueTimer)
      clearTimeout(queueTimer);
    if (state.cancelled)
      return undefined;
    if (rendererFailed)
      throw new Error(RENDERER_RESTARTING_ERROR);

    return withRenderTimeout(render).catch(error => {
      if (error instanceof RenderTimeoutError)
        failRenderer();
      throw error;
    });
  };
  const execution = renderQueue.then(execute, execute);
  const completed = execution.finally(() => {
    scheduledRenders--;
  });
  renderQueue = completed.catch(() => undefined);
  if (!waiting)
    return completed;
  return Promise.race([completed, waiting])
    .finally(() => clearTimeout(queueTimer));
}

function base64Encode(file) {
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

function beginRender() {
  if (rendererClosing || rendererFailed)
    throw new Error(RENDERER_RESTARTING_ERROR);
  rendererGeneration++;
  activeRenders++;
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = undefined;
  }
}

function scheduleIdleClose() {
  if (!IS_CHROME_OFFSCREEN ||
      activeRenders !== 0 ||
      rendererClosing ||
      rendererFailed)
    return;

  const generation = rendererGeneration;
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = undefined;
    if (activeRenders !== 0 ||
        rendererClosing ||
        rendererGeneration !== generation)
      return;
    Promise.resolve(chrome.runtime.sendMessage({
      generation,
      type: OFFSCREEN_IDLE_CLOSE_MESSAGE
    })).catch(error => console.warn(error.message));
  }, OFFSCREEN_IDLE_CLOSE_MS);
}

function finishRender() {
  activeRenders--;
  scheduleIdleClose();
}

function failRenderer() {
  if (rendererFailed)
    return;
  rendererFailed = true;

  if (!IS_CHROME_OFFSCREEN) {
    setTimeout(() => {
      globalThis.location.reload();
    }, 0);
    return;
  }

  Promise.resolve(chrome.runtime.sendMessage({
    type: OFFSCREEN_RESTART_MESSAGE
  })).then(response => {
    if (response?.ok === true)
      return;
    const message = response?.error ||
      "The failed renderer could not be replaced.";
    console.warn(message);
    globalThis.location.reload();
  }, error => {
    console.warn(error.message);
    globalThis.location.reload();
  });
}

function isServiceWorkerSender(sender) {
  if (sender?.id !== chrome.runtime.id || sender.tab)
    return false;
  return sender.url === undefined ||
    sender.url === chrome.runtime.getURL(CHROME_SERVICE_WORKER_PATH);
}

function handleOffscreenCloseControl(message, sender, sendResponse) {
  if (!isServiceWorkerSender(sender) ||
      (message?.type !== OFFSCREEN_PREPARE_CLOSE_MESSAGE &&
       message?.type !== OFFSCREEN_CANCEL_CLOSE_MESSAGE))
    return undefined;

  const generation = message.generation;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    sendResponse({ ok: false });
    return false;
  }

  if (message.type === OFFSCREEN_PREPARE_CLOSE_MESSAGE) {
    const idle = !rendererClosing &&
      activeRenders === 0 &&
      rendererGeneration === generation;
    if (idle) {
      rendererClosing = true;
      closingGeneration = generation;
      if (idleCloseTimer) {
        clearTimeout(idleCloseTimer);
        idleCloseTimer = undefined;
      }
    }
    sendResponse({ ok: idle });
    return false;
  }

  const cancelled = rendererClosing &&
    closingGeneration === generation;
  if (cancelled) {
    rendererClosing = false;
    closingGeneration = undefined;
    scheduleIdleClose();
  }
  sendResponse({ ok: cancelled });
  return false;
}

async function compile2pngDataURL(request) {
  const { source, display, scale, alpha } = validateRenderRequest(request);
  beginRender();
  const rendering = enqueueRender(() =>
    renderSvg(source, display).then(svg => rasterizeSvg(svg, scale, alpha))
  );
  rendering.then(finishRender, finishRender);
  const png = await rendering;
  return {
    code: Communicator.SUCCESS,
    payload: {
      dataUrl: `data:image/png;base64,${base64Encode(png)}`
    }
  };
}

function setupMessageHandler(comm) {
  comm.messageHandler.compile2pngDataURL = compile2pngDataURL;
}

function isGmailPort(port) {
  const senderUrl = port?.sender?.url || port?.sender?.tab?.url || "";
  return /^https:\/\/mail\.google\.com(?:\/|$)/.test(senderUrl);
}

if (IS_CHROME_OFFSCREEN)
  chrome.runtime.onMessage.addListener(handleOffscreenCloseControl);

chrome.runtime.onConnect.addListener(port => {
  if (!isGmailPort(port)) {
    port.disconnect();
    return;
  }

  const comm = new Communicator(port);
  ports.set(port, comm);
  setupMessageHandler(comm);
  port.onDisconnect.addListener(() => ports.delete(port));
});
