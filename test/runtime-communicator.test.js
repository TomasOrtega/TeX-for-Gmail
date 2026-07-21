"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadCommunicator(consoleErrors = []) {
  const filename = path.join(
    __dirname,
    "..",
    "chrome-extension",
    "src",
    "communicator.js"
  );
  const source = `${fs.readFileSync(filename, "utf8")}
globalThis.__Communicator = Communicator;`;
  const context = vm.createContext({
    console: {
      error(error) {
        consoleErrors.push(error);
      }
    },
    globalThis: {},
    Math,
    Promise
  });

  vm.runInContext(source, context, { filename });
  return context.globalThis.__Communicator;
}

async function flushMessages() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    emit(...args) {
      for (const listener of listeners)
        listener(...args);
    },
    removeListener(listener) {
      listeners.delete(listener);
    }
  };
}

function runtimePort() {
  const sent = [];
  return {
    onDisconnect: createEvent(),
    onMessage: createEvent(),
    postMessage(message) {
      sent.push(message);
    },
    sent
  };
}

test("pending requests reject when a Firefox runtime port disconnects", async () => {
  const Communicator = loadCommunicator();
  const port = runtimePort();
  const comm = new Communicator(port);
  let rejection;

  comm.request("ready", {}).catch(error => {
    rejection = error;
  });
  port.onDisconnect.emit();
  await Promise.resolve();

  assert.match(String(rejection?.err || rejection), /disconnect/i);
});

test("pending requests include a runtime port disconnect error", async () => {
  const Communicator = loadCommunicator();
  const port = runtimePort();
  port.error = { message: "worker failed" };
  const comm = new Communicator(port);
  const request = comm.request("ready", {});

  port.onDisconnect.emit();

  await assert.rejects(
    request,
    error => /worker failed/.test(error.err)
  );
});

test("requests validate commands and bound pending work", async () => {
  const Communicator = loadCommunicator();
  const port = runtimePort();
  const comm = new Communicator(port);

  assert.equal(Communicator.SUCCESS, "1");
  await assert.rejects(
    comm.request("not-valid!", {}),
    error => /command name/i.test(error.err)
  );

  const pending = Array.from(
    { length: Communicator.MAX_PENDING_REQUESTS },
    () => comm.request("ready", {})
  );
  await assert.rejects(
    comm.request("ready", {}),
    error => /too many pending/i.test(error.err)
  );
  port.onDisconnect.emit();
  await Promise.allSettled(pending);
});

test("request IDs advance, wrap within bounds, and skip pending IDs", async () => {
  const Communicator = loadCommunicator();
  const port = runtimePort();
  const comm = new Communicator(port);

  const pending = [comm.request("ready", {})];
  assert.equal(port.sent.at(-1).id, 1);

  comm.nextRequestId = Communicator.MAX_REQUEST_ID;
  pending.push(comm.request("ready", {}));
  assert.equal(port.sent.at(-1).id, Communicator.MAX_REQUEST_ID);

  pending.push(comm.request("ready", {}));
  assert.equal(port.sent.at(-1).id, 2);
  assert.ok(port.sent.every(message =>
    Number.isSafeInteger(message.id) &&
    message.id > 0 &&
    message.id <= Communicator.MAX_REQUEST_ID
  ));

  port.onDisconnect.emit();
  await Promise.allSettled(pending);
});

test("request failures remove entries that could not be posted", async () => {
  const Communicator = loadCommunicator();
  const port = runtimePort();
  port.postMessage = () => {
    throw new Error("transport rejected message");
  };
  const comm = new Communicator(port);

  await assert.rejects(
    comm.request("ready", {}),
    error => /transport rejected/i.test(error.err)
  );
  assert.equal(comm.pendingRequests.size, 0);
});

test("request replies resolve and reject their matching promises", async () => {
  const Communicator = loadCommunicator();
  const port = runtimePort();
  const comm = new Communicator(port);

  const success = comm.request("ready", {});
  port.onMessage.emit({
    code: Communicator.SUCCESS,
    id: port.sent.at(-1).id,
    payload: { ready: true }
  });
  assert.deepEqual({ ...await success }, { ready: true });

  const failure = comm.request("compile", {});
  port.onMessage.emit({
    code: Communicator.FAILURE,
    id: port.sent.at(-1).id,
    payload: { err: "compile failed" }
  });
  await assert.rejects(
    failure,
    error => error.err === "compile failed"
  );
});

test("unknown commands return cloneable failure payloads", async () => {
  const Communicator = loadCommunicator();
  const port = runtimePort();
  new Communicator(port);

  port.onMessage.emit({
    code: Communicator.REQUEST,
    id: 42,
    payload: {
      cmd: "missing",
      params: {}
    }
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(port.sent.length, 1);
  assert.equal(port.sent[0].code, Communicator.FAILURE);
  assert.equal(typeof port.sent[0].payload.err, "string");
  assert.match(port.sent[0].payload.err, /Unknown command/);
});

test("inherited object names are not treated as commands", async () => {
  const Communicator = loadCommunicator();
  const port = runtimePort();
  new Communicator(port);

  port.onMessage.emit({
    code: Communicator.REQUEST,
    id: 44,
    payload: {
      cmd: "constructor",
      params: {}
    }
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(port.sent.length, 1);
  assert.equal(port.sent[0].code, Communicator.FAILURE);
  assert.match(port.sent[0].payload.err, /Unknown command/);
});

test("malformed requests return a failure instead of throwing", async () => {
  const Communicator = loadCommunicator();
  const port = runtimePort();
  new Communicator(port);

  assert.doesNotThrow(() => {
    port.onMessage.emit({
      code: Communicator.REQUEST,
      id: 43,
      payload: null
    });
  });
  await Promise.resolve();

  assert.equal(port.sent.length, 1);
  assert.equal(port.sent[0].code, Communicator.FAILURE);
  assert.match(port.sent[0].payload.err, /Malformed/i);
});

test("request handlers return success and convert failures to replies", async () => {
  const Communicator = loadCommunicator();
  const port = runtimePort();
  const comm = new Communicator(port);
  comm.messageHandler.echo = params => ({
    code: Communicator.SUCCESS,
    payload: params
  });

  port.onMessage.emit({
    code: Communicator.REQUEST,
    id: 50,
    payload: {
      cmd: "echo",
      params: { value: 1 }
    }
  });
  await flushMessages();
  assert.equal(port.sent.at(-1).code, Communicator.SUCCESS);
  assert.deepEqual({ ...port.sent.at(-1).payload }, { value: 1 });

  comm.messageHandler.invalid = () => ({ payload: {} });
  port.onMessage.emit({
    code: Communicator.REQUEST,
    id: 51,
    payload: {
      cmd: "invalid",
      params: {}
    }
  });
  await flushMessages();
  assert.equal(port.sent.at(-1).code, Communicator.FAILURE);
  assert.match(port.sent.at(-1).payload.err, /invalid response/i);

  comm.messageHandler.reject = () => Promise.reject(
    new Error("asynchronous handler failure")
  );
  port.onMessage.emit({
    code: Communicator.REQUEST,
    id: 52,
    payload: {
      cmd: "reject",
      params: {}
    }
  });
  await flushMessages();
  assert.equal(port.sent.at(-1).code, Communicator.FAILURE);
  assert.match(port.sent.at(-1).payload.err, /asynchronous handler failure/i);

  comm.messageHandler.throw = () => {
    throw new Error("synchronous handler failure");
  };
  port.onMessage.emit({
    code: Communicator.REQUEST,
    id: 53,
    payload: {
      cmd: "throw",
      params: {}
    }
  });
  assert.equal(port.sent.at(-1).code, Communicator.FAILURE);
  assert.match(port.sent.at(-1).payload.err, /synchronous handler failure/i);
});

test("reply transport errors are contained and logged", async () => {
  const consoleErrors = [];
  const Communicator = loadCommunicator(consoleErrors);
  const port = runtimePort();
  const comm = new Communicator(port);
  comm.messageHandler.echo = () => ({
    code: Communicator.SUCCESS,
    payload: {}
  });
  port.postMessage = () => {
    throw new Error("reply transport failed");
  };

  port.onMessage.emit({
    code: Communicator.REQUEST,
    id: 54,
    payload: {
      cmd: "echo",
      params: {}
    }
  });
  await flushMessages();

  assert.equal(consoleErrors.length, 1);
  assert.match(String(consoleErrors[0]), /reply transport failed/i);
});
