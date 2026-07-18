"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPool() {
  const filename = path.join(
    __dirname,
    "..",
    "chrome-extension",
    "src",
    "pool.js"
  );
  const source = `${fs.readFileSync(filename, "utf8")}
globalThis.__Pool = Pool;`;
  const context = vm.createContext({
    clearTimeout,
    globalThis: {},
    Promise,
    setTimeout
  });

  vm.runInContext(source, context, { filename });
  return context.globalThis.__Pool;
}

function makePool(Pool, overrides = {}) {
  return new Pool({
    autoRelease: true,
    cons: () => ({}),
    count: 1,
    free: () => {},
    multiplier: 1,
    name: "runtime-test",
    ...overrides
  });
}

test("failed initialization returns the permit for a retry", async () => {
  const Pool = loadPool();
  let attempts = 0;
  const pool = makePool(Pool, {
    initialize: async () => {
      attempts++;
      if (attempts === 1)
        throw new Error("not ready");
    }
  });

  await assert.rejects(pool.process(() => "unused"), /not ready/);
  assert.equal(await pool.process(() => "ready"), "ready");
});

test("synchronous task failures return the permit", async () => {
  const Pool = loadPool();
  const pool = makePool(Pool);

  await assert.rejects(pool.process(() => {
    throw new Error("compile failed");
  }), /compile failed/);
  assert.equal(await pool.process(() => "recovered"), "recovered");
});

test("destroying a pool during initialization prevents queued work", async () => {
  const Pool = loadPool();
  let resolveInitialization;
  let taskCalled = false;
  const initialization = new Promise(resolve => {
    resolveInitialization = resolve;
  });
  const pool = makePool(Pool, {
    initialize: () => initialization
  });
  const result = pool.process(() => {
    taskCalled = true;
  });

  await Promise.resolve();
  pool.destroy();
  resolveInitialization();

  await assert.rejects(result, /destroyed/i);
  assert.equal(taskCalled, false);
  assert.equal(pool.resourcePool.length, 0);
});

test("initialization is optional", async () => {
  const Pool = loadPool();
  const pool = makePool(Pool);

  assert.equal(await pool.process(() => "done"), "done");
});

test("timed-out work terminates and replaces its resource", async () => {
  const Pool = loadPool();
  const freed = [];
  let nextId = 0;
  const pool = makePool(Pool, {
    cons: () => ({ id: ++nextId }),
    free: resource => freed.push(resource.id)
  });

  await assert.rejects(
    pool.process(
      () => new Promise(() => {}),
      {
        retireOnError: true,
        timeoutMs: 10,
        timeoutMessage: "Rendering timed out."
      }
    ),
    /Rendering timed out/
  );

  assert.deepEqual(freed, [1]);
  assert.deepEqual(
    Array.from(pool.realPool, resource => resource.id),
    [2]
  );
  assert.deepEqual(
    Array.from(pool.resourcePool, resource => resource.id),
    [2]
  );
  assert.equal(pool.semaphore.availableNo, 1);
  assert.equal(await pool.process(resource => resource.id), 2);
});

test("failed worker work can retire a poisoned resource", async () => {
  const Pool = loadPool();
  const freed = [];
  let nextId = 0;
  const pool = makePool(Pool, {
    cons: () => ({ id: ++nextId }),
    free: resource => freed.push(resource.id)
  });

  await assert.rejects(
    pool.process(
      () => {
        throw new Error("worker aborted");
      },
      { retireOnError: true }
    ),
    /worker aborted/
  );

  assert.deepEqual(freed, [1]);
  assert.equal(await pool.process(resource => resource.id), 2);
});

test("retiring a multiplied resource replaces its idle copies", () => {
  const Pool = loadPool();
  const freed = [];
  let nextId = 0;
  const pool = makePool(Pool, {
    cons: () => ({ id: ++nextId }),
    free: resource => freed.push(resource.id),
    multiplier: 2
  });
  const original = pool.realPool[0];

  const replacement = pool.retire(original);

  assert.equal(replacement.id, 2);
  assert.deepEqual(freed, [1]);
  assert.deepEqual(
    Array.from(pool.resourcePool, resource => resource.id),
    [2, 2]
  );
});

test("the pool rejects excess queued work", async () => {
  const Pool = loadPool();
  let release;
  const held = new Promise(resolve => {
    release = resolve;
  });
  const pool = makePool(Pool, { maxQueue: 1 });
  const first = pool.process(() => held);
  const second = pool.process(() => "queued");

  await assert.rejects(
    pool.process(() => "excess"),
    /busy/i
  );

  release("first");
  assert.equal(await first, "first");
  assert.equal(await second, "queued");
});
