"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPopup(options = {}) {
  let submitListener;
  let closed = false;
  const sent = [];
  const submit = {
    disabled: false
  };
  const form = {
    addEventListener(type, listener) {
      if (type === "submit")
        submitListener = listener;
    },
    querySelector(selector) {
      assert.equal(selector, "button");
      return submit;
    }
  };
  const elements = {
    "#display": {
      checked: options.display ?? false
    },
    "#latex": {
      value: options.latex || "$x^2$"
    },
    "#latex-form": form,
    "#status": {
      textContent: ""
    }
  };
  const browser = {
    tabs: {
      async query() {
        return [options.tab || {
          id: 7,
          url: "https://mail.google.com/mail/u/0/#inbox"
        }];
      },
      async sendMessage(tabId, message) {
        sent.push({ message, tabId });
        if (options.sendError)
          throw options.sendError;
        return options.result || { ok: true };
      }
    }
  };
  const context = vm.createContext({
    browser,
    document: {
      querySelector(selector) {
        return elements[selector];
      }
    },
    globalThis: {},
    Promise,
    window: {
      close() {
        closed = true;
      }
    }
  });
  context.globalThis = context;

  const filename = path.join(
    __dirname,
    "..",
    "chrome-extension",
    "popup",
    "popup.js"
  );
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });

  return {
    closeCalled: () => closed,
    elements,
    sent,
    submitButton: submit,
    submitForm: async () => {
      let prevented = false;
      await submitListener({
        preventDefault() {
          prevented = true;
        }
      });
      return prevented;
    }
  };
}

test("popup sends an explicit render request to the active Gmail tab", async () => {
  const runtime = loadPopup({
    display: true,
    latex: "$$x^2$$"
  });

  assert.equal(await runtime.submitForm(), true);
  assert.equal(runtime.submitButton.disabled, true);
  assert.equal(runtime.elements["#status"].textContent, "Rendering…");
  assert.equal(runtime.sent.length, 1);
  assert.equal(runtime.sent[0].tabId, 7);
  assert.deepEqual({ ...runtime.sent[0].message }, {
    display: true,
    latex: "$$x^2$$",
    type: "tex-for-gmail:render"
  });
  assert.equal(runtime.closeCalled(), true);
});

test("popup accepts a valid zero-valued tab ID", async () => {
  const runtime = loadPopup({
    tab: {
      id: 0,
      url: "https://mail.google.com/mail/u/0/#inbox"
    }
  });

  await runtime.submitForm();
  assert.equal(runtime.sent.length, 1);
  assert.equal(runtime.sent[0].tabId, 0);
});

test("popup rejects non-Gmail and lookalike tabs", async () => {
  for (const url of [
    "https://example.com/",
    "https://mail.google.com.example.com/"
  ]) {
    const runtime = loadPopup({
      tab: {
        id: 8,
        url
      }
    });

    await runtime.submitForm();
    assert.equal(runtime.sent.length, 0);
    assert.match(runtime.elements["#status"].textContent, /Gmail draft/i);
    assert.equal(runtime.submitButton.disabled, false);
    assert.equal(runtime.closeCalled(), false);
  }
});

test("popup displays render and messaging failures", async () => {
  const rejectedRender = loadPopup({
    result: {
      error: "LaTeX compilation timed out.",
      ok: false
    }
  });
  await rejectedRender.submitForm();
  assert.equal(
    rejectedRender.elements["#status"].textContent,
    "LaTeX compilation timed out."
  );
  assert.equal(rejectedRender.submitButton.disabled, false);

  const messagingFailure = loadPopup({
    sendError: {
      err: "Content script unavailable."
    }
  });
  await messagingFailure.submitForm();
  assert.equal(
    messagingFailure.elements["#status"].textContent,
    "Content script unavailable."
  );
});
