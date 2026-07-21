#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { stageTarget } = require("./stage-extension.js");

const FIXTURE = fs.readFileSync(
  path.join(__dirname, "..", "test", "fixtures", "render-smoke.tex"),
  "utf8"
).trim();
const INLINE_BREAK_FIXTURE = String.raw`\mathcal{E} + 1 = 1`;
const INLINE_PREFIX_FIXTURE = String.raw`\mathcal{E}`;
const MACRO_BASELINE_FIXTURE = String.raw`\frac{1}{2}`;
const MACRO_ISOLATED_FIXTURE = String.raw`\frac {1}{2}`;
const MACRO_MUTATION_FIXTURE =
  String.raw`\renewcommand{\frac}[2]{X}\frac{1}{2}`;
const STYLED_UNICODE_FIXTURES = Object.freeze([
  { label: "unicode-normal", source: String.raw`\mathrm{é}` },
  { label: "unicode-bold", source: String.raw`\mathbf{é}` },
  { label: "unicode-italic", source: String.raw`\mathit{é}` },
  {
    label: "unicode-bold-italic",
    source: String.raw`\boldsymbol{\mathit{é}}`
  },
  { label: "unicode-sans-serif", source: String.raw`\mathsf{é}` },
  { label: "unicode-monospace", source: String.raw`\mathtt{é}` }
]);
const SMOKE_RENDER_LABELS = Object.freeze([
  "feature",
  "inline",
  "inline-prefix",
  "macro-baseline",
  "macro-mutation",
  "macro-isolated",
  "multiline",
  ...STYLED_UNICODE_FIXTURES.map(({ label }) => label)
]);
const DYNAMIC_FILES = Object.freeze([
  "arrows.js",
  "calligraphic.js",
  "double-struck.js",
  "fraktur.js",
  "latin.js",
  "latin-b.js",
  "latin-bi.js",
  "latin-i.js",
  "math.js",
  "monospace-l.js",
  "monospace.js",
  "sans-serif-r.js",
  "sans-serif.js",
  "shapes.js",
  "symbols-b-i.js"
]);
const GMAIL_DOCUMENT_URL = "https://mail.google.com/mail/u/0/";
const GMAIL_PAGE_URL =
  `${GMAIL_DOCUMENT_URL}#tex-for-gmail-browser-smoke`;

function chromeCandidates() {
  return [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
}

function findChrome() {
  const executable = chromeCandidates().find(candidate =>
    fs.existsSync(candidate)
  );
  if (!executable)
    throw new Error("Chrome was not found. Set CHROME_PATH to its executable.");
  return executable;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function removeTemporaryTree(directory, {
  attempts = 21,
  removeTree = target => fs.promises.rm(target, {
    force: true,
    maxRetries: 2,
    recursive: true,
    retryDelay: 100
  }),
  retryDelayMs = 250,
  wait = delay
} = {}) {
  const transientErrors = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await removeTree(directory);
      return;
    } catch (error) {
      if (error.code === "ENOENT")
        return;
      if (!transientErrors.has(error.code) || attempt === attempts)
        throw error;
    }
    await wait(retryDelayMs);
  }
}

function waitForBrowserExit(browser, timeoutMs) {
  if (browser.exitCode != null || browser.signalCode != null)
    return Promise.resolve(true);
  return new Promise(resolve => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      browser.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    browser.once("exit", onExit);
  });
}

async function terminateBrowser(browser, {
  killTimeoutMs = 2000,
  termTimeoutMs = 2000
} = {}) {
  if (browser.exitCode != null || browser.signalCode != null)
    return;

  browser.kill("SIGTERM");
  if (await waitForBrowserExit(browser, termTimeoutMs))
    return;

  browser.kill("SIGKILL");
  if (!await waitForBrowserExit(browser, killTimeoutMs))
    throw new Error("Chrome did not exit after SIGKILL.");
}

function commonChromeArguments(profile) {
  return [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-features=OptimizationHints,MediaRouter",
    "--disable-sync",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--no-first-run",
    `--user-data-dir=${profile}`
  ];
}

function extensionChromeArguments({ profile }) {
  return [
    ...commonChromeArguments(profile),
    "--enable-unsafe-extension-debugging",
    "--remote-debugging-pipe",
    "about:blank"
  ];
}

async function waitForProtocolTarget(cdp, predicate, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { targetInfos } = await cdp.command("Target.getTargets");
    const target = targetInfos.find(predicate);
    if (target)
      return target;
    await delay(50);
  }
  throw new Error(`${description} did not become available to DevTools.`);
}

function attachedSession(cdp, sessionId) {
  return {
    command(method, params) {
      return cdp.command(method, params, sessionId);
    },
    on(method, listener) {
      return cdp.on(method, listener, sessionId);
    }
  };
}

function protocolConnection({
  close,
  commandTimeoutMs = 30000,
  send,
  subscribe,
  subscribeError = () => {}
}) {
  let nextId = 1;
  let terminalError;
  const pending = new Map();
  const listeners = new Map();
  const eventErrors = [];
  const diagnosticsBySession = new Map();

  function diagnostics(sessionId) {
    let result = diagnosticsBySession.get(sessionId);
    if (!result) {
      result = {
        cspIssues: [],
        exceptions: [],
        failedRequests: [],
        requestUrls: new Map(),
        requests: []
      };
      diagnosticsBySession.set(sessionId, result);
    }
    return result;
  }

  function recordDiagnostics(message, result) {
    if (message.method === "Network.requestWillBeSent") {
      result.requests.push(message.params.request.url);
      result.requestUrls.set(
        message.params.requestId,
        message.params.request.url
      );
    }
    if (message.method === "Network.responseReceived" &&
        message.params.response.status >= 400) {
      result.failedRequests.push({
        error: `HTTP ${message.params.response.status}`,
        url: message.params.response.url
      });
    }
    if (message.method === "Network.loadingFailed") {
      result.failedRequests.push({
        error: message.params.errorText,
        url: result.requestUrls.get(message.params.requestId)
      });
    }
    if (message.method === "Runtime.exceptionThrown")
      result.exceptions.push(message.params.exceptionDetails.text);
    if (message.method === "Audits.issueAdded" &&
        message.params.issue.code === "ContentSecurityPolicyIssue") {
      result.cspIssues.push(
        message.params.issue.details.contentSecurityPolicyIssueDetails
      );
    }
  }

  function failure(error) {
    if (terminalError)
      return;
    terminalError = error instanceof Error ? error : new Error(String(error));
    for (const operation of pending.values()) {
      clearTimeout(operation.timer);
      operation.reject(terminalError);
    }
    pending.clear();
  }

  function listenerKey(method, sessionId) {
    return `${sessionId === undefined ? "" : sessionId}\0${method}`;
  }

  subscribe(message => {
    if (message.id) {
      const operation = pending.get(message.id);
      if (!operation)
        return;
      pending.delete(message.id);
      clearTimeout(operation.timer);
      if (message.error)
        operation.reject(
          new Error(`${operation.method} failed: ${message.error.message}`)
        );
      else
        operation.resolve(message.result);
      return;
    }
    if (message.sessionId !== undefined)
      recordDiagnostics(message, diagnostics(message.sessionId));

    const handlers = listeners.get(
      listenerKey(message.method, message.sessionId)
    );
    for (const handler of handlers || []) {
      try {
        Promise.resolve(handler(message.params)).catch(error => {
          eventErrors.push(error);
        });
      } catch (error) {
        eventErrors.push(error);
      }
    }
  });
  subscribeError(failure);

  function command(method, params = {}, sessionId) {
    if (terminalError)
      return Promise.reject(terminalError);
    const id = nextId++;
    const operation = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(
          `${method} timed out after ${commandTimeoutMs} milliseconds.`
        ));
      }, commandTimeoutMs);
      pending.set(id, { method, reject, resolve, timer });
    });
    try {
      send({
        id,
        method,
        params,
        ...(sessionId === undefined ? {} : { sessionId })
      });
    } catch (error) {
      const current = pending.get(id);
      if (current) {
        pending.delete(id);
        clearTimeout(current.timer);
        current.reject(error);
      }
    }
    return operation;
  }

  function on(method, listener, sessionId) {
    const key = listenerKey(method, sessionId);
    let handlers = listeners.get(key);
    if (!handlers) {
      handlers = new Set();
      listeners.set(key, handlers);
    }
    handlers.add(listener);
    return () => {
      handlers.delete(listener);
      if (handlers.size === 0)
        listeners.delete(key);
    };
  }

  return {
    close() {
      failure(new Error("Chrome DevTools connection closed."));
      close();
    },
    command,
    diagnostics,
    eventErrors,
    on
  };
}

function connectPipe(browser, options = {}) {
  const input = browser.stdio[3];
  const output = browser.stdio[4];
  let buffer = Buffer.alloc(0);
  let listener;
  let fail;
  output.on("data", chunk => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      let boundary;
      while ((boundary = buffer.indexOf(0)) !== -1) {
        const packet = buffer.subarray(0, boundary);
        buffer = buffer.subarray(boundary + 1);
        if (packet.length)
          listener?.(JSON.parse(packet.toString("utf8")));
      }
    } catch (error) {
      fail?.(error);
    }
  });
  input.on("error", error => fail?.(error));
  input.on("close", () => {
    fail?.(new Error("Chrome DevTools input pipe closed."));
  });
  output.on("error", error => fail?.(error));
  output.on("end", () => {
    fail?.(new Error("Chrome DevTools output pipe ended."));
  });
  output.on("close", () => {
    fail?.(new Error("Chrome DevTools output pipe closed."));
  });
  browser.on("error", error => fail?.(error));
  browser.on("exit", (code, signal) => {
    const detail = code === null ? ` from signal ${signal}` :
      ` with code ${code}`;
    fail?.(new Error(`Chrome exited${detail}.`));
  });
  return protocolConnection({
    ...options,
    close: () => input.end(),
    send: message => input.write(`${JSON.stringify(message)}\0`),
    subscribe(handler) {
      listener = handler;
    },
    subscribeError(handler) {
      fail = handler;
    }
  });
}

async function evaluateValue(
  cdp,
  expression,
  awaitPromise = false,
  contextId
) {
  const evaluated = await cdp.command("Runtime.evaluate", {
    awaitPromise,
    expression,
    returnByValue: true,
    ...(contextId === undefined ? {} : { contextId })
  });
  if (evaluated.exceptionDetails) {
    const exception = evaluated.exceptionDetails.exception?.description ||
      evaluated.exceptionDetails.text;
    throw new Error(exception);
  }
  return evaluated.result.value;
}

function transientEvaluationError(error) {
  return /Cannot find (?:default )?execution context|context was destroyed|Inspected target navigated or closed|Cannot find context with specified id|No frame with given id/i.test(
    error.message
  );
}

async function waitForEvaluation(
  cdp,
  expression,
  description,
  { timeoutMs = 30000 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await evaluateValue(cdp, expression);
      if (result)
        return result;
    } catch (error) {
      if (!transientEvaluationError(error))
        throw error;
    }
    await delay(Math.min(50, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `${description} did not finish within ${timeoutMs} milliseconds.`
  );
}

function waitForProtocolEvent(
  cdp,
  method,
  description,
  { predicate = () => true, timeoutMs = 10000 } = {}
) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(
        `${description} did not occur within ${timeoutMs} milliseconds.`
      ));
    }, timeoutMs);
    unsubscribe = cdp.on(method, params => {
      if (!predicate(params))
        return;
      clearTimeout(timer);
      unsubscribe();
      resolve(params);
    });
  });
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function gmailSmokeDocument() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <link rel="icon" href="data:,">
    <title>TeX for Gmail browser smoke</title>
  </head>
  <body>
    <div id="compose">
      <div role="toolbar">
        <span><button type="button" command="+bold">Bold</button></span>
      </div>
      <div id="editor" g_editable="true" contenteditable="true"
           role="textbox">
        <div data-smoke-render="feature">\\[${escapeHtml(FIXTURE)}\\]</div>
        <div data-smoke-render="inline">\\(${INLINE_BREAK_FIXTURE}\\)</div>
        <div data-smoke-render="inline-prefix">\\(${INLINE_PREFIX_FIXTURE}\\)</div>
        <div data-smoke-render="macro-baseline">\\(${MACRO_BASELINE_FIXTURE}\\)</div>
        <div data-smoke-render="macro-mutation">\\(${MACRO_MUTATION_FIXTURE}\\)</div>
        <div data-smoke-render="macro-isolated">\\(${MACRO_ISOLATED_FIXTURE}\\)</div>
        <div data-smoke-render="multiline" data-smoke-multiline="success">
          <div data-smoke-line="first">$$x</div>
          <div data-smoke-line="second">+y$$</div>
          <div data-smoke-line="after">after</div>
        </div>
        ${STYLED_UNICODE_FIXTURES.map(({ label, source }) =>
          `<div data-smoke-render="${label}">\\(${escapeHtml(source)}\\)</div>`
        ).join("\n        ")}
      </div>
    </div>
  </body>
</html>
`;
}

function trackExecutionContexts(cdp) {
  const contexts = new Map();
  cdp.on("Runtime.executionContextCreated", ({ context }) => {
    contexts.set(context.id, context);
  });
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
    contexts.delete(executionContextId);
  });
  cdp.on("Runtime.executionContextsCleared", () => {
    contexts.clear();
  });
  return contexts;
}

async function findExtensionContext(cdp, contexts, extensionId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const context of contexts.values()) {
      if (context.auxData?.isDefault)
        continue;
      try {
        const runtimeId = await evaluateValue(
          cdp,
          "globalThis.chrome?.runtime?.id || ''",
          false,
          context.id
        );
        if (runtimeId === extensionId)
          return context;
      } catch (error) {
        if (!transientEvaluationError(error))
          throw error;
      }
    }
    await delay(50);
  }
  throw new Error(
    "The manifest content script execution context did not become available."
  );
}

function requireDynamicFiles(requests, label) {
  for (const filename of DYNAMIC_FILES) {
    if (requests.some(url => url.endsWith(`/${filename}`)))
      continue;
    const loaded = DYNAMIC_FILES.filter(candidate =>
      requests.some(url => url.endsWith(`/${candidate}`))
    );
    throw new Error(
      `${label} did not load packaged ${filename} ` +
      `(loaded: ${loaded.join(", ") || "none"}).`
    );
  }
}

function requirePng(dataUrl) {
  if (typeof dataUrl !== "string" ||
      !dataUrl.startsWith("data:image/png;base64,"))
    throw new Error("Browser smoke test did not produce a PNG data URL.");
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  if (!png.subarray(0, 8).equals(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  ))
    throw new Error("Browser smoke test produced an invalid PNG.");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 4096 || height > 4096)
    throw new Error("Browser smoke test produced invalid dimensions.");
  return { bytes: png.byteLength, height, width };
}

async function smokeUnpackedExtension({
  chromePath,
  stageRoot
}) {
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "tex-gmail-extension-")
  );
  const browser = spawn(
    chromePath,
    extensionChromeArguments({ profile }),
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] }
  );
  const cdp = connectPipe(browser);
  const targetSessions = new Map();
  const targetInitializations = new Map();
  let stderr = "";
  browser.stderr.on("data", chunk => {
    stderr += chunk;
  });

  cdp.on("Target.attachedToTarget", params => {
    const { sessionId, targetInfo, waitingForDebugger } = params;
    targetSessions.set(targetInfo.targetId, sessionId);
    if (!["background_page", "other", "service_worker"].includes(
      targetInfo.type
    ) || targetInitializations.has(targetInfo.targetId))
      return;

    const session = attachedSession(cdp, sessionId);
    const initialization = (async () => {
      try {
        await Promise.all([
          session.command("Audits.enable"),
          session.command("Network.enable"),
          session.command("Runtime.enable")
        ]);
      } finally {
        if (waitingForDebugger)
          await session.command("Runtime.runIfWaitingForDebugger");
      }
    })();
    targetInitializations.set(targetInfo.targetId, initialization);
    initialization.catch(() => {});
  });

  async function sessionForTarget(target, description) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const sessionId = targetSessions.get(target.targetId);
      if (sessionId) {
        const initialization = targetInitializations.get(target.targetId);
        if (initialization) {
          try {
            await initialization;
          } catch (error) {
            throw new Error(
              `${description} setup failed: ${error.message}`
            );
          }
        }
        return {
          cdp: attachedSession(cdp, sessionId),
          diagnostics: cdp.diagnostics(sessionId),
          sessionId
        };
      }
      await delay(50);
    }
    throw new Error(`${description} was not attached to DevTools.`);
  }

  try {
    await cdp.command("Browser.getVersion");
    await cdp.command("Target.setDiscoverTargets", { discover: true });
    await cdp.command("Target.setAutoAttach", {
      autoAttach: true,
      filter: [
        { type: "service_worker" },
        { type: "background_page" },
        { type: "other" },
        { exclude: true }
      ],
      flatten: true,
      waitForDebuggerOnStart: true
    });
    const loadedExtension = await cdp.command("Extensions.loadUnpacked", {
      path: stageRoot
    });
    const extensionId = loadedExtension.id;
    const extensionInventory = await cdp.command(
      "Extensions.getExtensions"
    );
    const loadedExtensionInfo = extensionInventory.extensions.find(
      extension => extension.id === extensionId
    );
    if (!loadedExtensionInfo?.enabled ||
        path.resolve(loadedExtensionInfo.path) !== path.resolve(stageRoot)) {
      throw new Error(
        "Chrome did not enable the staged unpacked extension."
      );
    }

    const serviceWorkerUrl =
      `chrome-extension://${extensionId}/src/chrome-service-worker.js`;
    const offscreenUrl =
      `chrome-extension://${extensionId}/src/chrome-offscreen.html`;
    const { targetId } = await cdp.command("Target.createTarget", {
      url: "about:blank"
    });
    const target = await waitForProtocolTarget(
      cdp,
      candidate => candidate.targetId === targetId,
      "Gmail smoke page target"
    );
    const attachment = await cdp.command("Target.attachToTarget", {
      flatten: true,
      targetId: target.targetId
    });
    const gmail = attachedSession(cdp, attachment.sessionId);
    const gmailContexts = trackExecutionContexts(gmail);
    let fulfilledDocuments = 0;
    const unexpectedDocuments = [];
    gmail.on("Fetch.requestPaused", async request => {
      if (request.request.url !== GMAIL_DOCUMENT_URL) {
        unexpectedDocuments.push(request.request.url);
        await gmail.command("Fetch.failRequest", {
          errorReason: "BlockedByClient",
          requestId: request.requestId
        });
        return;
      }

      fulfilledDocuments++;
      await gmail.command("Fetch.fulfillRequest", {
        body: Buffer.from(gmailSmokeDocument()).toString("base64"),
        requestId: request.requestId,
        responseCode: 200,
        responseHeaders: [
          {
            name: "Content-Type",
            value: "text/html; charset=utf-8"
          }
        ]
      });
    });
    await Promise.all([
      gmail.command("Audits.enable"),
      gmail.command("Fetch.enable", {
        patterns: [
          {
            requestStage: "Request",
            resourceType: "Document",
            urlPattern: "https://mail.google.com/*"
          }
        ]
      }),
      gmail.command("Network.enable"),
      gmail.command("Page.enable"),
      gmail.command("Runtime.enable")
    ]);
    const pageLoaded = waitForProtocolEvent(
      gmail,
      "Page.loadEventFired",
      "Fulfilled Gmail document load",
      { timeoutMs: 15000 }
    );
    const navigation = await gmail.command("Page.navigate", {
      url: GMAIL_PAGE_URL
    });
    if (navigation.errorText) {
      throw new Error(
        `Fulfilled Gmail navigation failed: ` +
        `${navigation.errorText}`
      );
    }
    await pageLoaded;
    const injectedState = await waitForEvaluation(
      gmail,
      `location.href === ${JSON.stringify(GMAIL_PAGE_URL)} &&
       document.readyState === "complete" &&
       document.querySelector("[data-tex-for-gmail-toolbar-button]") && ({
        href: location.href,
        toolbarButtons:
          document.querySelectorAll("[data-tex-for-gmail-toolbar-button]").length
      })`,
      "Manifest content-script toolbar"
    );
    if (fulfilledDocuments !== 1 ||
        unexpectedDocuments.length ||
        injectedState.href !== GMAIL_PAGE_URL ||
        injectedState.toolbarButtons !== 1) {
      throw new Error(
        "The staged manifest did not inject exactly one Gmail toolbar."
      );
    }

    const extensionContext = await findExtensionContext(
      gmail,
      gmailContexts,
      extensionId
    );
    const readiness = await evaluateValue(gmail, `(async () => {
      try {
        return {
          response: await chrome.runtime.sendMessage({
            type: "tex-for-gmail:ensure-renderer"
          }),
          runtimeId: chrome.runtime.id
        };
      } catch (error) {
        return {
          error: error && (error.stack || error.message) || String(error)
        };
      }
    })()`, true, extensionContext.id);
    if (readiness.error ||
        readiness.runtimeId !== extensionId ||
        readiness.response?.ok !== true) {
      throw new Error(
        readiness.error ||
        readiness.response?.error ||
        "The authenticated Gmail renderer bootstrap failed."
      );
    }

    const serviceWorkerTarget = await waitForProtocolTarget(
      cdp,
      candidate =>
        candidate.type === "service_worker" &&
        candidate.url === serviceWorkerUrl,
      "Manifest service worker target"
    );
    const offscreenTarget = await waitForProtocolTarget(
      cdp,
      candidate => candidate.url === offscreenUrl,
      "Chrome offscreen renderer target"
    );
    const refreshedGmailTarget = await waitForProtocolTarget(
      cdp,
      candidate =>
        candidate.targetId === targetId &&
        candidate.type === "page" &&
        candidate.url === GMAIL_PAGE_URL,
      "Fulfilled Gmail page target"
    );
    const targetIds = new Set([
      refreshedGmailTarget.targetId,
      serviceWorkerTarget.targetId,
      offscreenTarget.targetId
    ]);
    const browserContextIds = new Set([
      refreshedGmailTarget.browserContextId,
      serviceWorkerTarget.browserContextId,
      offscreenTarget.browserContextId
    ]);
    if (targetIds.size !== 3 ||
        browserContextIds.has(undefined) ||
        browserContextIds.size !== 1 ||
        !["background_page", "other"].includes(offscreenTarget.type)) {
      throw new Error(
        "Gmail, service worker, and offscreen renderer were not distinct " +
        "targets in the same browser context."
      );
    }

    const serviceWorker = await sessionForTarget(
      serviceWorkerTarget,
      "Manifest service worker"
    );
    const offscreen = await sessionForTarget(
      offscreenTarget,
      "Chrome offscreen renderer"
    );
    const offscreenContexts = await evaluateValue(
      serviceWorker.cdp,
      `chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [${JSON.stringify(offscreenUrl)}]
      })`,
      true
    );
    if (offscreenContexts.length !== 1 ||
        offscreenContexts[0].contextType !== "OFFSCREEN_DOCUMENT" ||
        offscreenContexts[0].documentUrl !== offscreenUrl) {
      throw new Error(
        "The service worker did not create the expected offscreen document."
      );
    }

    const buttonPosition = await evaluateValue(gmail, `(() => {
      if (location.href !== ${JSON.stringify(GMAIL_PAGE_URL)})
        return undefined;
      const button = document.querySelector(
        "[data-tex-for-gmail-toolbar-button]"
      );
      const bounds = button?.getBoundingClientRect();
      if (!bounds || bounds.width < 1 || bounds.height < 1)
        return undefined;
      return {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2
      };
    })()`);
    if (!buttonPosition)
      throw new Error("The injected Gmail toolbar button was not clickable.");
    await gmail.command("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...buttonPosition
    });
    await gmail.command("Input.dispatchMouseEvent", {
      button: "left",
      clickCount: 1,
      type: "mousePressed",
      ...buttonPosition
    });
    await gmail.command("Input.dispatchMouseEvent", {
      button: "left",
      clickCount: 1,
      type: "mouseReleased",
      ...buttonPosition
    });

    const result = await waitForEvaluation(
      gmail,
      `(() => {
        if (location.href !== ${JSON.stringify(GMAIL_PAGE_URL)})
          return false;
        const images = {};
        for (const label of ${JSON.stringify(SMOKE_RENDER_LABELS)}) {
          images[label] = document.querySelector(
            '[data-smoke-render="' + label + '"] ' +
            'img[data-tex-for-gmail-rendered="1"]'
          )?.src;
        }
        if (Object.values(images).every(Boolean)) {
          const multiline = document.querySelector(
            '[data-smoke-multiline="success"]'
          );
          return {
            images,
            multiline: [...multiline.children].map(line => ({
              images: line.querySelectorAll(
                'img[data-tex-for-gmail-rendered="1"]'
              ).length,
              label: line.dataset.smokeLine,
              text: line.textContent
            })),
            ok: true,
            rendered: document.querySelectorAll(
              'img[data-tex-for-gmail-rendered="1"]'
            ).length
          };
        }
        const status = document.querySelector("#tex-for-gmail-status");
        if (status?.dataset.state === "error") {
          return {
            error: status.textContent,
            ok: false
          };
        }
        return false;
      })()`,
      "Gmail toolbar render"
    );
    if (result.ok !== true ||
        result.rendered !== SMOKE_RENDER_LABELS.length) {
      throw new Error(
        result.error ||
        `Gmail did not render ${SMOKE_RENDER_LABELS.length} expressions.`
      );
    }
    if (JSON.stringify(result.multiline) !== JSON.stringify([
      { images: 1, label: "first", text: "" },
      { images: 0, label: "after", text: "after" }
    ])) {
      throw new Error(
        "Multiline rendering did not remove its consumed Gmail line: " +
        JSON.stringify(result.multiline)
      );
    }
    const multilineFailure = await evaluateValue(
      gmail,
      `(async () => {
        const editor = document.querySelector("#editor");
        const host = document.createElement("div");
        host.dataset.smokeMultiline = "failure";
        host.innerHTML = ${JSON.stringify(
          '<div data-smoke-line="first">$$x</div>' +
          '<div data-smoke-line="second">+y$$</div>' +
          '<div data-smoke-line="after">after</div>'
        )};
        editor.append(host);
        const originalLines = [...host.children];
        const compile = compileWithRendererSession;
        compileWithRendererSession = async () => {
          throw new Error("Forced browser smoke render failure.");
        };
        try {
          const outcome = await renderAllMathInEditor(editor);
          return {
            lines: [...host.children].map(line => ({
              label: line.dataset.smokeLine,
              text: line.textContent
            })),
            outcome,
            pending: host.querySelectorAll(
              "[data-tex-for-gmail-pending]"
            ).length,
            sameNodes: originalLines.every(
              (line, index) => host.children[index] === line
            )
          };
        } finally {
          compileWithRendererSession = compile;
        }
      })()`,
      true,
      extensionContext.id
    );
    if (multilineFailure.outcome?.ok !== false ||
        multilineFailure.outcome?.rendered !== 0 ||
        multilineFailure.pending !== 0 ||
        multilineFailure.sameNodes !== true ||
        JSON.stringify(multilineFailure.lines) !== JSON.stringify([
          { label: "first", text: "$$x" },
          { label: "second", text: "+y$$" },
          { label: "after", text: "after" }
        ])) {
      throw new Error(
        "A failed multiline render did not restore its exact Gmail lines."
      );
    }
    const renderedPngs = Object.fromEntries(
      Object.entries(result.images).map(([label, dataUrl]) =>
        [label, requirePng(dataUrl)])
    );
    if (renderedPngs.inline.width <=
        renderedPngs["inline-prefix"].width * 2) {
      throw new Error(
        "Inline SVG rendering omitted part of " +
        `${JSON.stringify(INLINE_BREAK_FIXTURE)} ` +
        `(${renderedPngs.inline.width}px versus ` +
        `${renderedPngs["inline-prefix"].width}px prefix).`
      );
    }
    if (result.images["macro-baseline"] !==
        result.images["macro-isolated"]) {
      throw new Error("TeX macro definitions leaked between render requests.");
    }
    const png = renderedPngs.feature;

    requireDynamicFiles(
      offscreen.diagnostics.requests,
      "Chrome offscreen renderer"
    );
    if (!offscreen.diagnostics.requests.some(url =>
      url.endsWith("/resources/mathjax/tex-svg.js"))) {
      throw new Error(
        "Chrome offscreen renderer did not load packaged MathJax."
      );
    }
    const extensionFailure = offscreen.diagnostics.failedRequests.find(failure =>
      failure.url?.startsWith(`chrome-extension://${extensionId}/`)
    );
    if (extensionFailure) {
      throw new Error(
        `Chrome offscreen renderer failed to load ${extensionFailure.url}: ` +
        `${extensionFailure.error}`
      );
    }
    const external = offscreen.diagnostics.requests.filter(
      url => /^https?:/i.test(url)
    );
    if (external.length) {
      throw new Error(
        `Chrome offscreen renderer made an external request: ${external[0]}`
      );
    }
    const gmailDiagnostics = cdp.diagnostics(attachment.sessionId);
    const unexpectedGmailRequest = gmailDiagnostics.requests.find(
      url => /^https?:/i.test(url) && url !== GMAIL_DOCUMENT_URL
    );
    if (unexpectedGmailRequest) {
      throw new Error(
        `Gmail smoke page made an external request: ${unexpectedGmailRequest}`
      );
    }
    const diagnostics = [
      ["Gmail smoke page", gmailDiagnostics],
      ["Manifest service worker", serviceWorker.diagnostics],
      ["Chrome offscreen renderer", offscreen.diagnostics]
    ];
    for (const [description, diagnostic] of diagnostics) {
      if (diagnostic.failedRequests.length) {
        const failure = diagnostic.failedRequests[0];
        throw new Error(
          `${description} failed to load ${failure.url || "a resource"}: ` +
          `${failure.error}`
        );
      }
      if (diagnostic.exceptions.length) {
        throw new Error(
          `${description} raised an exception: ${diagnostic.exceptions[0]}`
        );
      }
      if (diagnostic.cspIssues.length) {
        throw new Error(
          `${description} violated its content security policy: ` +
          `${diagnostic.cspIssues[0].violatedDirective}.`
        );
      }
    }
    const serviceWorkerExternal = serviceWorker.diagnostics.requests.find(
      url => /^https?:/i.test(url)
    );
    if (serviceWorkerExternal) {
      throw new Error(
        `Manifest service worker made an external request: ` +
        `${serviceWorkerExternal}`
      );
    }
    if (cdp.eventErrors.length) {
      throw new Error(
        `Chrome DevTools event handling failed: ` +
        `${cdp.eventErrors[0].message}`
      );
    }

    return {
      id: extensionId,
      ...png,
      offscreenUrl,
      requests: offscreen.diagnostics.requests,
      serviceWorkerUrl
    };
  } catch (error) {
    if (stderr.trim())
      error.message += `\nChrome stderr:\n${stderr.trim()}`;
    throw error;
  } finally {
    try {
      cdp.close();
    } catch {}
    try {
      await terminateBrowser(browser);
    } finally {
      await removeTemporaryTree(profile);
    }
  }
}

async function smokeBrowser({
  root = path.join(__dirname, ".."),
  chromePath = findChrome(),
  quiet = false
} = {}) {
  const { stageRoot } = stageTarget({
    root,
    target: "chrome",
    quiet: true
  });
  const result = await smokeUnpackedExtension({
    chromePath,
    stageRoot
  });

  if (!quiet) {
    console.log(
      `Unpacked MV3 extension rendered ${SMOKE_RENDER_LABELS.length} ` +
      `expressions through its Gmail content script, service worker, and ` +
      `offscreen document; the feature fixture was ` +
      `${result.width}x${result.height} (${result.bytes} bytes), with no ` +
      `external requests.`
    );
  }
  return result;
}

if (require.main === module) {
  smokeBrowser().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  connectPipe,
  DYNAMIC_FILES,
  extensionChromeArguments,
  FIXTURE,
  gmailSmokeDocument,
  INLINE_BREAK_FIXTURE,
  findChrome,
  protocolConnection,
  removeTemporaryTree,
  requirePng,
  smokeBrowser,
  STYLED_UNICODE_FIXTURES,
  terminateBrowser,
  waitForEvaluation
};
