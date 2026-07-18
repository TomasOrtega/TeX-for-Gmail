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

function eventTarget() {
  const listeners = new Map();
  const sent = [];
  return {
    emit(type, event) {
      for (const listener of listeners.get(type) || [])
        listener(event);
    },
    sent,
    addEventListener(type, listener) {
      if (!listeners.has(type))
        listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    postMessage(message) {
      sent.push(message);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    }
  };
}

test("pending requests reject when a Firefox runtime port disconnects", async () => {
  const Communicator = loadCommunicator();
  const target = eventTarget();
  const comm = new Communicator(target);
  let rejection;

  comm.request("ready", {}).catch(error => {
    rejection = error;
  });
  target.emit("disconnect");
  await Promise.resolve();

  assert.match(String(rejection?.err || rejection), /disconnect/i);
});

test("pending requests reject when their target reports an error", async () => {
  const Communicator = loadCommunicator();
  const target = eventTarget();
  const comm = new Communicator(target);
  const request = comm.request("ready", {});

  target.emit("error", { message: "worker failed" });

  await assert.rejects(
    request,
    error => /worker failed/.test(error.err)
  );
});

test("posts and requests validate commands and bound pending work", async () => {
  const Communicator = loadCommunicator();
  const target = eventTarget();
  const comm = new Communicator(target);

  assert.equal(Communicator.SUCCESS, "1");
  assert.equal(Communicator.POST, "3");
  comm.post("notify", { value: 1 });
  assert.equal(target.sent[0].code, Communicator.POST);
  assert.deepEqual({ ...target.sent[0].payload.params }, { value: 1 });
  assert.throws(() => comm.post("not-valid!", {}), /command name/i);
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
  target.emit("disconnect");
  await Promise.allSettled(pending);
});

test("request failures remove entries that could not be posted", async () => {
  const Communicator = loadCommunicator();
  const target = eventTarget();
  target.postMessage = () => {
    throw new Error("transport rejected message");
  };
  const comm = new Communicator(target);

  await assert.rejects(
    comm.request("ready", {}),
    error => /transport rejected/i.test(error.err)
  );
  assert.equal(comm.pendingRequests.size, 0);
});

test("request replies resolve and reject their matching promises", async () => {
  const Communicator = loadCommunicator();
  const target = eventTarget();
  const comm = new Communicator(target);

  const success = comm.request("ready", {});
  target.emit("message", {
    data: {
      code: Communicator.SUCCESS,
      id: target.sent.at(-1).id,
      payload: { ready: true }
    }
  });
  assert.deepEqual({ ...await success }, { ready: true });

  const failure = comm.request("compile", {});
  target.emit("message", {
    data: {
      code: Communicator.FAILURE,
      id: target.sent.at(-1).id,
      payload: { err: "compile failed" }
    }
  });
  await assert.rejects(
    failure,
    error => error.err === "compile failed"
  );
});

test("unknown commands return cloneable failure payloads", async () => {
  const Communicator = loadCommunicator();
  const target = eventTarget();
  new Communicator(target);

  target.emit("message", {
    data: {
      code: Communicator.REQUEST,
      id: 42,
      payload: {
        cmd: "missing",
        params: {}
      }
    }
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(target.sent.length, 1);
  assert.equal(target.sent[0].code, Communicator.FAILURE);
  assert.equal(typeof target.sent[0].payload.err, "string");
  assert.match(target.sent[0].payload.err, /Unknown command/);
});

test("inherited object names are not treated as commands", async () => {
  const Communicator = loadCommunicator();
  const target = eventTarget();
  new Communicator(target);

  target.emit("message", {
    data: {
      code: Communicator.REQUEST,
      id: 44,
      payload: {
        cmd: "constructor",
        params: {}
      }
    }
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(target.sent.length, 1);
  assert.equal(target.sent[0].code, Communicator.FAILURE);
  assert.match(target.sent[0].payload.err, /Unknown command/);
});

test("malformed requests return a failure instead of throwing", async () => {
  const Communicator = loadCommunicator();
  const target = eventTarget();
  new Communicator(target);

  assert.doesNotThrow(() => {
    target.emit("message", {
      data: {
        code: Communicator.REQUEST,
        id: 43,
        payload: null
      }
    });
  });
  await Promise.resolve();

  assert.equal(target.sent.length, 1);
  assert.equal(target.sent[0].code, Communicator.FAILURE);
  assert.match(target.sent[0].payload.err, /Malformed/i);
});

test("request handlers return success and convert failures to replies", async () => {
  const Communicator = loadCommunicator();
  const target = eventTarget();
  const comm = new Communicator(target);
  comm.messageHandler.echo = params => ({
    code: Communicator.SUCCESS,
    payload: params
  });

  target.emit("message", {
    data: {
      code: Communicator.REQUEST,
      id: 50,
      payload: {
        cmd: "echo",
        params: { value: 1 }
      }
    }
  });
  await flushMessages();
  assert.equal(target.sent.at(-1).code, Communicator.SUCCESS);
  assert.deepEqual({ ...target.sent.at(-1).payload }, { value: 1 });

  comm.messageHandler.invalid = () => ({ payload: {} });
  target.emit("message", {
    data: {
      code: Communicator.REQUEST,
      id: 51,
      payload: {
        cmd: "invalid",
        params: {}
      }
    }
  });
  await flushMessages();
  assert.equal(target.sent.at(-1).code, Communicator.FAILURE);
  assert.match(target.sent.at(-1).payload.err, /invalid response/i);

  comm.messageHandler.reject = () => Promise.reject(
    new Error("asynchronous handler failure")
  );
  target.emit("message", {
    data: {
      code: Communicator.REQUEST,
      id: 52,
      payload: {
        cmd: "reject",
        params: {}
      }
    }
  });
  await flushMessages();
  assert.equal(target.sent.at(-1).code, Communicator.FAILURE);
  assert.match(target.sent.at(-1).payload.err, /asynchronous handler failure/i);

  comm.messageHandler.throw = () => {
    throw new Error("synchronous handler failure");
  };
  target.emit("message", {
    data: {
      code: Communicator.REQUEST,
      id: 53,
      payload: {
        cmd: "throw",
        params: {}
      }
    }
  });
  assert.equal(target.sent.at(-1).code, Communicator.FAILURE);
  assert.match(target.sent.at(-1).payload.err, /synchronous handler failure/i);
});

test("reply transport errors are contained and logged", async () => {
  const consoleErrors = [];
  const Communicator = loadCommunicator(consoleErrors);
  const target = eventTarget();
  const comm = new Communicator(target);
  comm.messageHandler.echo = () => ({
    code: Communicator.SUCCESS,
    payload: {}
  });
  target.postMessage = () => {
    throw new Error("reply transport failed");
  };

  target.emit("message", {
    data: {
      code: Communicator.REQUEST,
      id: 54,
      payload: {
        cmd: "echo",
        params: {}
      }
    }
  });
  await flushMessages();

  assert.equal(consoleErrors.length, 1);
  assert.match(String(consoleErrors[0]), /reply transport failed/i);
});

test("post handlers report unknown commands and asynchronous failures", async () => {
  const consoleErrors = [];
  const Communicator = loadCommunicator(consoleErrors);
  const target = eventTarget();
  const comm = new Communicator(target);

  target.emit("message", {
    data: {
      code: Communicator.POST,
      id: 60,
      payload: {
        cmd: "missing",
        params: {}
      }
    }
  });
  assert.match(String(consoleErrors.at(-1)), /unknown command/i);

  comm.messageHandler.reject = () => Promise.reject(
    new Error("post handler failed")
  );
  target.emit("message", {
    data: {
      code: Communicator.POST,
      id: 61,
      payload: {
        cmd: "reject",
        params: {}
      }
    }
  });
  await flushMessages();

  assert.match(
    String(consoleErrors.at(-1)?.err || consoleErrors.at(-1)),
    /post handler failed/i
  );
});
