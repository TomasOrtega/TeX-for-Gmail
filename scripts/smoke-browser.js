#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { stageTarget } = require("./stage-extension.js");

const FIXTURE = fs.readFileSync(
  path.join(__dirname, "..", "test", "fixtures", "render-smoke.tex"),
  "utf8"
).trim();
const INLINE_BREAK_FIXTURE = String.raw`\mathcal{E} + 1 = 1`;
const DYNAMIC_FILES = Object.freeze([
  "arrows.js",
  "calligraphic.js",
  "double-struck.js",
  "fraktur.js",
  "latin.js",
  "math.js",
  "monospace.js",
  "sans-serif.js",
  "shapes.js",
  "symbols-b-i.js"
]);

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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForPage(port) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(target => target.type === "page");
      if (page)
        return page;
    } catch {}
    await delay(50);
  }
  throw new Error("Chrome DevTools endpoint did not become ready.");
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const requests = [];
  const requestUrls = new Map();
  const failedRequests = [];
  const exceptions = [];
  const cspIssues = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const operation = pending.get(message.id);
      if (!operation)
        return;
      pending.delete(message.id);
      if (message.error)
        operation.reject(new Error(message.error.message));
      else
        operation.resolve(message.result);
      return;
    }
    if (message.method === "Network.requestWillBeSent") {
      requests.push(message.params.request.url);
      requestUrls.set(
        message.params.requestId,
        message.params.request.url
      );
    }
    if (message.method === "Network.responseReceived" &&
        message.params.response.status >= 400) {
      failedRequests.push({
        error: `HTTP ${message.params.response.status}`,
        url: message.params.response.url
      });
    }
    if (message.method === "Network.loadingFailed") {
      failedRequests.push({
        error: message.params.errorText,
        url: requestUrls.get(message.params.requestId)
      });
    }
    if (message.method === "Runtime.exceptionThrown")
      exceptions.push(message.params.exceptionDetails.text);
    if (message.method === "Audits.issueAdded" &&
        message.params.issue.code === "ContentSecurityPolicyIssue")
      cspIssues.push(message.params.issue.details.contentSecurityPolicyIssueDetails);
  });

  function command(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { reject, resolve });
    });
  }
  return {
    command,
    cspIssues,
    exceptions,
    failedRequests,
    requests,
    socket
  };
}

function createHarness(stageRoot, directory) {
  fs.copyFileSync(
    path.join(stageRoot, "src", "background.js"),
    path.join(directory, "background.js")
  );
  fs.cpSync(
    path.join(stageRoot, "resources"),
    path.join(directory, "resources"),
    { recursive: true }
  );
  fs.writeFileSync(path.join(directory, "bootstrap.js"), `"use strict";
globalThis.chrome = {
  runtime: {
    id: "tex-for-gmail-smoke",
    getManifest: () => ({ manifest_version: 3 }),
    getURL: name => new URL(name, location.href).href,
    onConnect: { addListener() {} },
    onMessage: { addListener() {} },
    sendMessage: () => Promise.resolve()
  }
};
globalThis.Communicator = class {
  static get SUCCESS() { return "1"; }
};
globalThis.PortWrapper = class {};
`);
  fs.writeFileSync(path.join(directory, "run.js"), `"use strict";
globalThis.__done = false;
(async () => {
  try {
    const inline = await compile2pngDataURL({
      alpha: 1,
      display: false,
      scale: 2,
      source: ${JSON.stringify(INLINE_BREAK_FIXTURE)}
    });
    const inlinePrefix = await compile2pngDataURL({
      alpha: 1,
      display: false,
      scale: 2,
      source: "\\\\mathcal{E}"
    });
    const isolationRequest = {
      alpha: 1,
      display: false,
      scale: 2,
      source: "\\\\frac{1}{2}"
    };
    const baseline = await compile2pngDataURL(isolationRequest);
    await compile2pngDataURL({
      ...isolationRequest,
      source: "\\\\renewcommand{\\\\frac}[2]{X}\\\\frac{1}{2}"
    });
    const isolated = await compile2pngDataURL(isolationRequest);
    if (baseline.payload.dataUrl !== isolated.payload.dataUrl)
      throw new Error("TeX macro definitions leaked between render requests.");

    const response = await compile2pngDataURL({
      alpha: 1,
      display: true,
      scale: 2,
      source: ${JSON.stringify(FIXTURE)}
    });
    globalThis.__result = {
      dataUrl: response.payload.dataUrl,
      inlineDataUrl: inline.payload.dataUrl,
      inlinePrefixDataUrl: inlinePrefix.payload.dataUrl
    };
  } catch (error) {
    globalThis.__result = { error: error.stack || error.message || String(error) };
  } finally {
    globalThis.__done = true;
  }
})();
`);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(stageRoot, "manifest.json"), "utf8")
  );
  const csp = manifest.content_security_policy.extension_pages;
  fs.writeFileSync(path.join(directory, "index.html"), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <script src="bootstrap.js"></script>
    <script src="background.js"></script>
    <script src="run.js"></script>
  </head>
  <body></body>
</html>
`);
  return pathToFileURL(path.join(directory, "index.html")).href;
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tex-gmail-chrome-"));
  const harness = fs.mkdtempSync(path.join(os.tmpdir(), "tex-gmail-smoke-"));
  const pageUrl = createHarness(stageRoot, harness);
  const port = await freePort();
  const browser = spawn(chromePath, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-features=OptimizationHints,MediaRouter",
    "--disable-sync",
    "--no-first-run",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank"
  ], {
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  browser.stderr.on("data", chunk => {
    stderr += chunk;
  });

  try {
    const page = await waitForPage(port);
    const cdp = await connect(page);
    await Promise.all([
      cdp.command("Network.enable"),
      cdp.command("Page.enable"),
      cdp.command("Runtime.enable"),
      cdp.command("Audits.enable")
    ]);
    await cdp.command("Page.navigate", { url: pageUrl });

    let result;
    for (let attempt = 0; attempt < 300; attempt++) {
      const evaluated = await cdp.command("Runtime.evaluate", {
        expression: "globalThis.__done && globalThis.__result",
        returnByValue: true
      });
      result = evaluated.result.value;
      if (result)
        break;
      await delay(100);
    }
    if (!result)
      throw new Error("Browser renderer did not finish within 30 seconds.");
    if (result.error)
      throw new Error(result.error);

    const png = requirePng(result.dataUrl);
    const inline = requirePng(result.inlineDataUrl);
    const inlinePrefix = requirePng(result.inlinePrefixDataUrl);
    if (inline.width <= inlinePrefix.width * 2) {
      throw new Error(
        "Inline SVG rendering omitted part of " +
        `${JSON.stringify(INLINE_BREAK_FIXTURE)} ` +
        `(${inline.width}px versus ${inlinePrefix.width}px prefix).`
      );
    }
    const localFailure = cdp.failedRequests.find(failure =>
      failure.url?.startsWith("file:")
    );
    if (localFailure) {
      throw new Error(
        `Renderer failed to load ${localFailure.url}: ${localFailure.error}`
      );
    }
    const external = cdp.requests.filter(url => /^https?:/i.test(url));
    if (external.length)
      throw new Error(`Renderer made an external request: ${external[0]}`);
    for (const filename of DYNAMIC_FILES) {
      if (!cdp.requests.some(url => url.endsWith(`/${filename}`))) {
        const loaded = DYNAMIC_FILES.filter(candidate =>
          cdp.requests.some(url => url.endsWith(`/${candidate}`))
        );
        throw new Error(
          `Renderer did not load packaged ${filename} ` +
          `(loaded: ${loaded.join(", ") || "none"}).`
        );
      }
    }
    if (cdp.exceptions.length)
      throw new Error(`Renderer raised an exception: ${cdp.exceptions[0]}`);
    if (cdp.cspIssues.length) {
      throw new Error(
        "Renderer violated its content security policy: " +
        `${cdp.cspIssues[0].violatedDirective}.`
      );
    }
    cdp.socket.close();

    if (!quiet) {
      console.log(
        `Browser smoke test rendered ${png.width}x${png.height} ` +
        `(${png.bytes} bytes) with no external requests.`
      );
    }
    return { ...png, requests: cdp.requests };
  } catch (error) {
    if (stderr.trim())
      error.message += `\nChrome stderr:\n${stderr.trim()}`;
    throw error;
  } finally {
    if (browser.exitCode === null) {
      const exited = new Promise(resolve => browser.once("exit", resolve));
      browser.kill("SIGTERM");
      await Promise.race([exited, delay(2000)]);
    }
    fs.rmSync(harness, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100
    });
    fs.rmSync(profile, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100
    });
  }
}

if (require.main === module) {
  smokeBrowser().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DYNAMIC_FILES,
  FIXTURE,
  INLINE_BREAK_FIXTURE,
  createHarness,
  findChrome,
  requirePng,
  smokeBrowser
};
