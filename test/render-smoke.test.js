"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  connectPipe,
  DYNAMIC_FILES,
  extensionChromeArguments,
  FIXTURE,
  gmailSmokeDocument,
  INLINE_BREAK_FIXTURE,
  protocolConnection,
  removeTemporaryTree,
  requirePng,
  terminateBrowser,
  waitForEvaluation
} = require("../scripts/smoke-browser.js");

const root = path.join(__dirname, "..");

test("extension browser smoke covers renderer regressions in Gmail", () => {
  assert.equal(INLINE_BREAK_FIXTURE, String.raw`\mathcal{E} + 1 = 1`);
  const document = gmailSmokeDocument();
  assert.ok(document.includes('data-smoke-render="feature"'));
  assert.ok(document.includes(String.raw`\begin{aligned}`));
  for (const fixture of [
    ["inline", String.raw`\(${INLINE_BREAK_FIXTURE}\)`],
    ["inline-prefix", String.raw`\(\mathcal{E}\)`],
    ["macro-baseline", String.raw`\(\frac{1}{2}\)`],
    [
      "macro-mutation",
      String.raw`\(\renewcommand{\frac}[2]{X}\frac{1}{2}\)`
    ],
    ["macro-isolated", String.raw`\(\frac {1}{2}\)`]
  ]) {
    assert.ok(document.includes(`data-smoke-render="${fixture[0]}"`));
    assert.ok(document.includes(fixture[1]));
  }
});

test("browser smoke fixture covers the supported AMS and font features", () => {
  assert.equal(
    FIXTURE,
    fs.readFileSync(
      path.join(root, "test", "fixtures", "render-smoke.tex"),
      "utf8"
    ).trim()
  );
  for (const command of [
    String.raw`\begin{aligned}`,
    String.raw`\begin{pmatrix}`,
    String.raw`\backepsilon`,
    String.raw`\bigstar`,
    String.raw`\binom`,
    String.raw`\boldsymbol`,
    String.raw`\circledR`,
    String.raw`\int`,
    String.raw`\mathbb`,
    String.raw`\mathcal`,
    String.raw`\mathfrak`,
    String.raw`\mathsf{x}`,
    String.raw`\mathtt{x}`,
    String.raw`\operatorname`,
    String.raw`\rightsquigarrow`,
    String.raw`\text`,
    String.raw`\varsubsetneq`,
    String.raw`\vec`,
    String.raw`\yen`
  ])
    assert.ok(FIXTURE.includes(command), command);
  assert.match(FIXTURE, /café.*naïve/s);
  assert.deepEqual([...DYNAMIC_FILES], [
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
});

test("browser smoke output validation accepts only bounded PNG images", () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(196, 20);
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

  assert.deepEqual(requirePng(dataUrl), {
    bytes: 24,
    height: 196,
    width: 640
  });
  assert.throws(() => requirePng("data:text/plain;base64,eA=="), /PNG data URL/);
  assert.throws(
    () => requirePng("data:image/png;base64,AAAA"),
    /invalid PNG/
  );
  png.writeUInt32BE(4097, 16);
  assert.throws(
    () => requirePng(`data:image/png;base64,${png.toString("base64")}`),
    /invalid dimensions/
  );
});

test("browser smoke uses the trusted pipe for unpacked extension loading", () => {
  const launchArguments = extensionChromeArguments({
    profile: "/tmp/tex-gmail-extension-profile"
  });

  assert.ok(launchArguments.includes("--disable-background-networking"));
  assert.ok(launchArguments.includes(
    "--host-resolver-rules=MAP * ~NOTFOUND"
  ));
  assert.ok(launchArguments.includes("--enable-unsafe-extension-debugging"));
  assert.ok(launchArguments.includes("--remote-debugging-pipe"));
  assert.equal(launchArguments.some(argument =>
    argument.startsWith("--load-extension=")), false);
  assert.equal(launchArguments.some(argument =>
    argument.startsWith("--disable-extensions-except=")), false);
});

test("browser protocol commands have a bounded deadline", async () => {
  const cdp = protocolConnection({
    close() {},
    commandTimeoutMs: 10,
    send() {},
    subscribe() {}
  });

  await assert.rejects(
    cdp.command("Never.responds"),
    /Never\.responds timed out/
  );
});

test("browser pipe exit rejects pending and future protocol commands", async () => {
  const browser = new EventEmitter();
  browser.stdio = [];
  browser.stdio[3] = new PassThrough();
  browser.stdio[4] = new PassThrough();
  const cdp = connectPipe(browser, { commandTimeoutMs: 1000 });
  const pending = cdp.command("Browser.getVersion");

  browser.emit("exit", 19, null);

  await assert.rejects(pending, /Chrome exited with code 19/);
  await assert.rejects(
    cdp.command("Target.getTargets"),
    /Chrome exited with code 19/
  );
});

test("browser cleanup escalates from SIGTERM to SIGKILL and reaps", async () => {
  const browser = new EventEmitter();
  const signals = [];
  browser.exitCode = null;
  browser.kill = signal => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      browser.exitCode = 137;
      queueMicrotask(() => browser.emit("exit", 137, signal));
    }
    return true;
  };

  await terminateBrowser(browser, {
    killTimeoutMs: 100,
    termTimeoutMs: 1
  });

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(browser.exitCode, 137);
});

test("temporary profile cleanup retries transient directory races", async () => {
  const removals = [];
  const waits = [];
  const transient = Object.assign(new Error("directory not empty"), {
    code: "ENOTEMPTY"
  });

  await removeTemporaryTree("/tmp/tex-gmail-profile", {
    attempts: 4,
    removeTree(directory) {
      removals.push(directory);
      if (removals.length < 4)
        throw transient;
    },
    retryDelayMs: 25,
    wait(milliseconds) {
      waits.push(milliseconds);
      return Promise.resolve();
    }
  });

  assert.deepEqual(removals, Array(4).fill("/tmp/tex-gmail-profile"));
  assert.deepEqual(waits, [25, 25, 25]);
});

test("browser evaluation retries transient navigation context errors", async () => {
  let attempts = 0;
  const cdp = {
    async command() {
      attempts++;
      if (attempts === 1)
        throw new Error("Execution context was destroyed.");
      return { result: { value: "ready" } };
    }
  };

  assert.equal(
    await waitForEvaluation(cdp, "true", "Navigated page", {
      timeoutMs: 100
    }),
    "ready"
  );
  assert.equal(attempts, 2);
});
