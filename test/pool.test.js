"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPoolClasses() {
  const filename = path.join(
    __dirname,
    "..",
    "chrome-extension",
    "src",
    "pool.js"
  );
  const source = `${fs.readFileSync(filename, "utf8")}
globalThis.__poolClasses = { Pool, Semaphore };`;
  const context = vm.createContext({
    Promise,
    globalThis: {}
  });

  vm.runInContext(source, context, { filename });
  return context.globalThis.__poolClasses;
}

test("Pool waits for asynchronous resource initialization before work", async () => {
  const { Pool } = loadPoolClasses();
  let initialized = false;
  let releaseInitialization;
  const initialization = new Promise(resolve => {
    releaseInitialization = () => {
      initialized = true;
      resolve();
    };
  });
  const pool = new Pool({
    name: "test",
    count: 1,
    cons: () => ({}),
    free: () => {},
    autoRelease: true,
    initialize: () => initialization,
    multiplier: 1
  });

  const result = pool.process(() => {
    assert.equal(initialized, true);
    return Promise.resolve("done");
  });

  await Promise.resolve();
  releaseInitialization();
  assert.equal(await result, "done");
});
