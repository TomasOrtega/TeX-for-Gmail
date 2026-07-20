"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadScript(filename, expression, globals = {}) {
  const absolutePath = path.join(
    __dirname,
    "..",
    "chrome-extension",
    "src",
    filename
  );
  const context = vm.createContext(globals);
  vm.runInContext(fs.readFileSync(absolutePath, "utf8"), context, {
    filename: absolutePath
  });
  return vm.runInContext(expression, context);
}

function createEvent() {
  const listeners = new Set();
  return {
    listeners,
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    }
  };
}

test("PortWrapper maps runtime port events and message envelopes", () => {
  const PortWrapper = loadScript(
    "portwrapper.js",
    "PortWrapper"
  );
  const onDisconnect = createEvent();
  const onMessage = createEvent();
  const sent = [];
  const wrapper = new PortWrapper({
    onDisconnect,
    onMessage,
    postMessage(message) {
      sent.push(message);
    }
  });
  const messageListener = () => {};
  const disconnectListener = () => {};

  wrapper.addEventListener("message", messageListener);
  wrapper.addEventListener("disconnect", disconnectListener);
  wrapper.addEventListener("unsupported", () => {});
  assert.equal(onMessage.listeners.has(messageListener), true);
  assert.equal(onDisconnect.listeners.has(disconnectListener), true);

  wrapper.postMessage({ id: 42 }, ["ignored-transfer-list"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.id, 42);

  wrapper.removeEventListener("message", messageListener);
  wrapper.removeEventListener("disconnect", disconnectListener);
  wrapper.removeEventListener("unsupported", () => {});
  assert.equal(onMessage.listeners.size, 0);
  assert.equal(onDisconnect.listeners.size, 0);
});
