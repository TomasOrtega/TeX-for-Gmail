"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const latex = require("../chrome-extension/src/latex.js");

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function loadComposeContent(source, options = {}) {
  const bootstrapMessages = [];
  const commands = [];
  const editorEvents = [];
  const ports = [];
  const requests = [];
  const timers = [];
  let connectCount = 0;

  function dataKey(name) {
    return name.slice(5).replace(/-([a-z])/g, (_match, letter) =>
      letter.toUpperCase()
    );
  }

  function attributeValue(element, name) {
    if (name.startsWith("data-"))
      return element.dataset[dataKey(name)] ?? element.attributes[name];
    return element.attributes[name];
  }

  function matchesSelector(element, selector) {
    return selector.split(",").some(part => {
      const candidate = part.trim();
      const tag = candidate.match(/^[a-z]+/i)?.[0];
      if (tag && element.tagName !== tag.toUpperCase())
        return false;
      const id = candidate.match(/#([\w-]+)/)?.[1];
      if (id && element.id !== id)
        return false;
      for (const className of candidate.match(/\.[\w-]+/g) || []) {
        if (!element.className.split(/\s+/).includes(className.slice(1)))
          return false;
      }
      for (const match of candidate.matchAll(
        /\[([^\]=]+)(?:="([^"]*)")?\]/g
      )) {
        const value = attributeValue(element, match[1]);
        if (value === undefined ||
            (match[2] !== undefined && value !== match[2]))
          return false;
      }
      return true;
    });
  }

  function descendants(node) {
    const nodes = [];
    for (const child of node.childNodes || []) {
      nodes.push(child);
      nodes.push(...descendants(child));
    }
    return nodes;
  }

  class FakeNode {
    constructor(nodeType) {
      this.childNodes = [];
      this.nodeType = nodeType;
      this.parentNode = undefined;
    }

    get isConnected() {
      return this === document.documentElement || Boolean(this.parentNode?.isConnected);
    }

    get nextSibling() {
      const siblings = this.parentNode?.childNodes || [];
      return siblings[siblings.indexOf(this) + 1];
    }

    get previousSibling() {
      const siblings = this.parentNode?.childNodes || [];
      return siblings[siblings.indexOf(this) - 1];
    }

    remove() {
      const siblings = this.parentNode?.childNodes;
      if (!siblings)
        return;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentNode = undefined;
    }

    replaceWith(node) {
      const siblings = this.parentNode?.childNodes;
      if (!siblings)
        return;
      const index = siblings.indexOf(this);
      siblings[index] = node;
      node.parentNode = this.parentNode;
      this.parentNode = undefined;
    }
  }

  class FakeText extends FakeNode {
    constructor(data) {
      super(3);
      this.data = data;
    }

    get parentElement() {
      return this.parentNode;
    }

    get textContent() {
      return this.data;
    }

    set textContent(value) {
      this.data = value;
    }
  }

  class FakeElement extends FakeNode {
    constructor(tagName = "div") {
      super(1);
      this.attributes = {};
      this.className = "";
      this.dataset = {};
      this.id = "";
      this.listeners = new Map();
      this.tagName = tagName.toUpperCase();
    }

    append(...nodes) {
      for (const node of nodes) {
        const child = typeof node === "string" ? new FakeText(node) : node;
        child.remove();
        child.parentNode = this;
        this.childNodes.push(child);
      }
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (node.nodeType === 1 && matchesSelector(node, selector))
          return node;
      }
      return undefined;
    }

    contains(node) {
      return node === this || descendants(this).includes(node);
    }

    dispatchEvent(event) {
      event.target ||= this;
      if (this.isEditor)
        editorEvents.push(event);
      for (const listener of this.listeners.get(event.type) || [])
        listener(event);
      return !event.defaultPrevented;
    }

    get parentElement() {
      return this.parentNode;
    }

    get textContent() {
      return this.childNodes.map(node => node.textContent).join("");
    }

    set textContent(value) {
      this.childNodes = [];
      if (value)
        this.append(new FakeText(value));
    }

    insertBefore(node, reference) {
      node.remove();
      node.parentNode = this;
      const index = reference ? this.childNodes.indexOf(reference) : -1;
      if (index < 0)
        this.childNodes.push(node);
      else
        this.childNodes.splice(index, 0, node);
      return node;
    }

    matches(selector) {
      return matchesSelector(this, selector);
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0];
    }

    querySelectorAll(selector) {
      return descendants(this).filter(node =>
        node.nodeType === 1 && matchesSelector(node, selector)
      );
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "class")
        this.className = String(value);
    }

    removeAttribute(name) {
      delete this.attributes[name];
      if (name.startsWith("data-"))
        delete this.dataset[dataKey(name)];
    }
  }

  class FakeRange {
    cloneRange() {
      const range = new FakeRange();
      range.commonAncestorContainer = this.commonAncestorContainer;
      range.endContainer = this.endContainer;
      range.endOffset = this.endOffset;
      range.startContainer = this.startContainer;
      range.startOffset = this.startOffset;
      return range;
    }

    get collapsed() {
      return this.startContainer === this.endContainer &&
        this.startOffset === this.endOffset;
    }

    collapse(toStart) {
      if (toStart) {
        this.endContainer = this.startContainer;
        this.endOffset = this.startOffset;
      } else {
        this.startContainer = this.endContainer;
        this.startOffset = this.endOffset;
      }
    }

    deleteContents() {
      const node = this.startContainer;
      const parent = node.parentNode;
      const after = new FakeText(node.data.slice(this.endOffset));
      node.data = node.data.slice(0, this.startOffset);
      this.after = after;
      parent.insertBefore(after, node.nextSibling);
      this.endContainer = node;
      this.endOffset = this.startOffset;
    }

    insertNode(node) {
      this.startContainer.parentNode.insertBefore(node, this.after);
    }

    setEnd(node, offset) {
      this.endContainer = node;
      this.endOffset = offset;
      this.commonAncestorContainer = node.nodeType === 1
        ? node
        : node.parentNode;
    }

    setStart(node, offset) {
      this.startContainer = node;
      this.startOffset = offset;
      this.commonAncestorContainer = node.nodeType === 1
        ? node
        : node.parentNode;
    }

    selectNode(node) {
      const parent = node.parentNode;
      const offset = parent.childNodes.indexOf(node);
      this.setStart(parent, offset);
      this.setEnd(parent, offset + 1);
      this.commonAncestorContainer = parent;
    }

    toString() {
      if (this.startContainer === this.endContainer &&
          this.startContainer?.nodeType === 3)
        return this.startContainer.data.slice(this.startOffset, this.endOffset);
      return "";
    }
  }

  class FakeImage extends FakeElement {
    constructor() {
      super("img");
      this.naturalHeight = options.imageHeight ?? 40;
      this.naturalWidth = options.imageWidth ?? 80;
    }

    set src(value) {
      this.source = value;
      queueMicrotask(() => {
        const event = options.imageError ? "error" : "load";
        for (const listener of this.listeners.get(event) || [])
          listener();
      });
    }
  }

  const documentListeners = new Map();
  const document = {
    body: undefined,
    documentElement: new FakeElement("html"),
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    createRange() {
      return new FakeRange();
    },
    createTextNode(value) {
      return new FakeText(value);
    },
    createTreeWalker(root, _showText, filter) {
      const nodes = descendants(root).filter(node =>
        node.nodeType === 3 && filter.acceptNode(node) === 1
      );
      let index = 0;
      return {
        nextNode() {
          return nodes[index++];
        }
      };
    },
    execCommand(command, _showUi, value) {
      commands.push({ command, value });
      if (options.nativeInsertText && command === "insertText") {
        const range = selection.currentRange;
        const image = range?.startContainer?.childNodes[range.startOffset];
        if (!image)
          return false;
        const text = new FakeText(value);
        image.replaceWith(text);
        const caret = new FakeRange();
        caret.setStart(text, value.length);
        caret.setEnd(text, value.length);
        selection.removeAllRanges();
        selection.addRange(caret);
        editor.dispatchEvent({
          bubbles: true,
          inputType: "insertText",
          type: "input"
        });
        return true;
      }
      return false;
    },
    querySelector(selector) {
      return this.documentElement.querySelector(selector);
    },
    querySelectorAll(selector) {
      return this.documentElement.querySelectorAll(selector);
    }
  };
  document.body = options.noBody ? undefined : document.documentElement;

  function createEditor(initialSource, gmailEditable = true) {
    const editor = new FakeElement("div");
    editor.isEditor = true;
    editor.setAttribute("aria-multiline", "true");
    editor.setAttribute("contenteditable", "true");
    if (gmailEditable)
      editor.setAttribute("g_editable", "true");
    editor.setAttribute("role", "textbox");
    editor.append(new FakeText(initialSource));
    return editor;
  }

  function createCompose(initialSource, config = {}) {
    const withToolbar = config.withToolbar ?? true;
    const dialog = new FakeElement("div");
    dialog.setAttribute("role", "dialog");
    const editor = createEditor(initialSource, config.gmailEditable);

    let bold;
    let toolbar;
    if (withToolbar) {
      toolbar = new FakeElement("div");
      toolbar.setAttribute("role", "toolbar");
      bold = new FakeElement("div");
      bold.setAttribute("command", "+bold");
      toolbar.append(bold);
      dialog.append(toolbar);
    } else if (config.boldOutsideToolbar) {
      bold = new FakeElement("div");
      bold.setAttribute("command", "+bold");
      dialog.append(bold);
    }
    dialog.append(editor);
    const additionalEditors = (config.additionalSources || []).map(value =>
      createEditor(value, config.gmailEditable)
    );
    dialog.append(...additionalEditors);
    document.documentElement.append(dialog);
    return { additionalEditors, bold, dialog, editor, toolbar };
  }

  const { additionalEditors, bold, dialog, editor, toolbar } = createCompose(
    source,
    options
  );

  const selection = {
    currentRange: undefined,
    rangeCount: 0,
    addRange(range) {
      this.currentRange = range;
      this.rangeCount = 1;
    },
    getRangeAt() {
      return this.currentRange;
    },
    removeAllRanges() {
      this.currentRange = undefined;
      this.rangeCount = 0;
    }
  };
  const onMessage = createEvent();
  let mutationCallback;
  const context = vm.createContext({
    atob: options.atob || atob,
    browser: {
      runtime: {
        connect({ name }) {
          connectCount++;
          const onDisconnect = createEvent();
          const port = {
            disconnectCalls: 0,
            disconnected: false,
            disconnect() {
              this.disconnectCalls++;
              if (this.disconnected)
                return;
              this.disconnected = true;
              for (const listener of onDisconnect.listeners)
                listener();
            },
            onDisconnect
          };
          port.name = name;
          ports.push(port);
          return port;
        },
        onMessage,
        async sendMessage(message) {
          bootstrapMessages.push(message);
          if (options.bootstrapError)
            throw options.bootstrapError;
          return options.bootstrapResult || { ok: true };
        }
      }
    },
    clearTimeout() {},
    Communicator: class {
      constructor(wrapper) {
        this.port = wrapper.target;
      }

      request(_command, request) {
        requests.push(request);
        if (options.request)
          return options.request(request, this.port);
        return Promise.resolve({
          dataUrl: "data:image/png;base64,iVBORw0KGgo="
        });
      }
    },
    document,
    Image: FakeImage,
    InputEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    MutationObserver: options.noMutationObserver ? undefined : class {
      constructor(callback) {
        mutationCallback = callback;
      }

      observe() {}
    },
    Node: {
      ELEMENT_NODE: 1,
      TEXT_NODE: 3
    },
    NodeFilter: {
      FILTER_ACCEPT: 1,
      FILTER_REJECT: 2,
      SHOW_TEXT: 4
    },
    PortWrapper: class {
      constructor(target) {
        this.target = target;
      }
    },
    Promise,
    queueMicrotask,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    TeXForGmail: latex,
    window: {
      getSelection() {
        return selection;
      }
    }
  });
  context.globalThis = context;
  const filename = path.join(
    __dirname,
    "..",
    "chrome-extension",
    "src",
    "contentscr.js"
  );
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });

  return {
    api: vm.runInContext(`({
      renderAllMathInEditor: typeof renderAllMathInEditor === "undefined"
        ? undefined : renderAllMathInEditor,
      requirePngDataUrl: typeof requirePngDataUrl === "undefined"
        ? undefined : requirePngDataUrl,
      loadImage: typeof loadImage === "undefined" ? undefined : loadImage,
      syncGmailToolbars: typeof syncGmailToolbars === "undefined"
        ? undefined : syncGmailToolbars,
      scheduleToolbarSync: typeof scheduleToolbarSync === "undefined"
        ? undefined : scheduleToolbarSync,
      formattingAnchor: typeof formattingAnchor === "undefined"
        ? undefined : formattingAnchor
    })`, context),
    bold,
    bootstrapMessages,
    commands,
    connectCount: () => connectCount,
    additionalEditors,
    createCompose,
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    dialog,
    document,
    documentListeners,
    editor,
    editorEvents,
    makeElementRange(node, startOffset, endOffset = startOffset) {
      const range = new FakeRange();
      range.setStart(node, startOffset);
      range.setEnd(node, endOffset);
      range.commonAncestorContainer = node;
      return range;
    },
    makeRange(node, offset) {
      const range = new FakeRange();
      range.setStart(node, offset);
      range.setEnd(node, offset);
      return range;
    },
    ports,
    requests,
    selection,
    toolbar,
    timers,
    triggerMutation() {
      mutationCallback?.([]);
    }
  };
}

test("Gmail toolbar renders delimited math and restores it before deletion", async () => {
  const runtime = loadComposeContent(String.raw`Use $x^2$ and \(y\).`);

  assert.equal(typeof runtime.api.syncGmailToolbars, "function");
  runtime.api.syncGmailToolbars();
  const button = runtime.toolbar.querySelector(
    "[data-tex-for-gmail-toolbar-button]"
  );
  assert.ok(button);
  assert.equal(runtime.toolbar.childNodes[1], button);
  const mouseDown = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    type: "mousedown"
  };
  button.dispatchEvent(mouseDown);
  assert.equal(mouseDown.defaultPrevented, true);

  assert.deepEqual(
    { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
    { ok: true, rendered: 2 }
  );
  assert.deepEqual(
    runtime.requests.map(request => request.source).sort(),
    [String.raw`x^2`, String.raw`y`]
  );
  const [image] = runtime.editor.querySelectorAll(
    'img[data-tex-for-gmail-rendered="1"]'
  );
  assert.ok(image);
  assert.equal(image.alt, "Rendered math expression");
  assert.equal(image.dataset.texForGmailSource, undefined);
  assert.equal(image.contentEditable, "false");

  runtime.selection.addRange(runtime.makeRange(image.nextSibling, 0));
  const deletion = {
    defaultPrevented: false,
    inputType: "deleteContentBackward",
    preventDefault() {
      this.defaultPrevented = true;
    },
    type: "beforeinput"
  };
  runtime.editor.dispatchEvent(deletion);
  assert.equal(deletion.defaultPrevented, true);
  assert.match(runtime.editor.textContent, /\$x\^2\$/);
  assert.deepEqual(runtime.commands.at(-1), {
    command: "insertText",
    value: "$x^2$"
  });
  assert.equal(
    runtime.editor.querySelectorAll('img[data-tex-for-gmail-rendered="1"]')
      .some(candidate => candidate.dataset.texForGmailSource === "$x^2$"),
    false
  );
  assert.equal(runtime.editorEvents.at(-1).type, "input");
});

test("Gmail toolbar renders numeric dollar-delimited expressions", async () => {
  const runtime = loadComposeContent("$1+1=2$");

  assert.deepEqual(
    { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
    { ok: true, rendered: 1 }
  );
  assert.deepEqual(runtime.requests.map(request => ({
    display: request.display,
    source: request.source
  })), [{
    display: false,
    source: "1+1=2"
  }]);
  assert.equal(
    runtime.editor.querySelectorAll(
      'img[data-tex-for-gmail-rendered="1"]'
    ).length,
    1
  );
});

test("Gmail toolbar keeps changed pending math editable", async () => {
  let resolveRender;
  const runtime = loadComposeContent("$x$", {
    request() {
      return new Promise(resolve => {
        resolveRender = resolve;
      });
    }
  });

  const rendering = runtime.api.renderAllMathInEditor(runtime.editor);
  await new Promise(resolve => setImmediate(resolve));
  const pending = runtime.editor.querySelector("[data-tex-for-gmail-pending]");
  assert.ok(pending);
  pending.textContent = "$y$";
  resolveRender({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" });

  assert.deepEqual(
    { ...await rendering },
    { ok: true, rendered: 0 }
  );
  assert.equal(
    runtime.editor.querySelector("[data-tex-for-gmail-pending]"),
    undefined
  );
  assert.equal(runtime.editor.textContent, "$y$");
});

test("Gmail toolbar clears failed, changed pending math", async () => {
  let rejectRender;
  const runtime = loadComposeContent("$x$", {
    request() {
      return new Promise((_resolve, reject) => {
        rejectRender = reject;
      });
    }
  });

  const rendering = runtime.api.renderAllMathInEditor(runtime.editor);
  await new Promise(resolve => setImmediate(resolve));
  const pending = runtime.editor.querySelector("[data-tex-for-gmail-pending]");
  pending.textContent = "$y$";
  rejectRender(new Error("Renderer failed."));

  assert.deepEqual(
    { ...await rendering },
    { ok: false, rendered: 0 }
  );
  assert.equal(
    runtime.editor.querySelector("[data-tex-for-gmail-pending]"),
    undefined
  );
  assert.equal(runtime.editor.textContent, "$y$");
});

test("Gmail toolbar leaves ordinary mixed selections to Gmail", async () => {
  const runtime = loadComposeContent("$x$word");
  await runtime.api.renderAllMathInEditor(runtime.editor);
  const image = runtime.editor.querySelector(
    'img[data-tex-for-gmail-rendered="1"]'
  );
  const imageOffset = runtime.editor.childNodes.indexOf(image);
  runtime.selection.addRange(
    runtime.makeElementRange(runtime.editor, imageOffset + 1, imageOffset + 2)
  );
  const deletion = {
    defaultPrevented: false,
    inputType: "deleteContentBackward",
    preventDefault() {
      this.defaultPrevented = true;
    },
    type: "beforeinput"
  };

  runtime.editor.dispatchEvent(deletion);

  assert.equal(deletion.defaultPrevented, false);
  assert.equal(
    runtime.editor.querySelector('img[data-tex-for-gmail-rendered="1"]'),
    image
  );
});

test("Gmail toolbar declines ambiguous or non-toolbar formatting controls", () => {
  const shared = loadComposeContent("$x$", {
    additionalSources: ["$y$"]
  });
  const buttonSelector = "[data-tex-for-gmail-toolbar-button]";
  assert.equal(shared.toolbar.querySelector(buttonSelector), undefined);
  assert.equal(
    shared.api.formattingAnchor(shared.additionalEditors[0]),
    undefined
  );

  const unrelated = loadComposeContent("$x$", {
    boldOutsideToolbar: true,
    withToolbar: false
  });
  assert.equal(unrelated.dialog.querySelector(buttonSelector), undefined);
  assert.equal(unrelated.api.formattingAnchor(unrelated.editor), undefined);
});

test("Gmail toolbar ignores rich-text fields that are not compose bodies", () => {
  const runtime = loadComposeContent("$x$", {
    gmailEditable: false
  });

  assert.equal(
    runtime.toolbar.querySelector("[data-tex-for-gmail-toolbar-button]"),
    undefined
  );
});

test("Gmail toolbar reports empty drafts and clears status messages", async () => {
  const runtime = loadComposeContent("No math here.");

  assert.deepEqual(
    { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
    { ok: true, rendered: 0 }
  );
  assert.equal(runtime.document.querySelector("#tex-for-gmail-status").textContent,
    "No delimited math found.");
  assert.equal(runtime.timers.at(-1).delay, 6000);
  runtime.timers.at(-1).callback();
  assert.equal(runtime.document.querySelector("#tex-for-gmail-status"), undefined);
});

test("Gmail toolbar gives display math its own layout", async () => {
  const runtime = loadComposeContent("Before $$x^2$$ after.");

  assert.deepEqual(
    { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
    { ok: true, rendered: 1 }
  );
  assert.equal(
    runtime.editor.querySelector('img[data-tex-for-gmail-rendered="1"]')
      .className,
    "tex-for-gmail-image tex-for-gmail-display"
  );
});

test("Gmail toolbar leaves excess formulas for the next batch", async () => {
  const source = Array.from({ length: 51 }, (_value, index) =>
    `$x_${index}$`
  ).join(" ");
  const runtime = loadComposeContent(source);

  assert.deepEqual(
    { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
    { ok: false, rendered: 50 }
  );
  assert.equal(runtime.requests.length, 50);
  assert.match(
    runtime.document.querySelector("#tex-for-gmail-status").textContent,
    /Batch limit reached/
  );
});

test("Gmail toolbar recovers one restarting renderer and rejects bad images", async () => {
  let attempts = 0;
  const restarting = loadComposeContent("$x$", {
    request(_request, port) {
      attempts++;
      if (attempts === 1) {
        for (const listener of port.onDisconnect.listeners)
          listener();
        return Promise.reject({ err: "Communication target disconnected." });
      }
      return Promise.resolve({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" });
    }
  });

  assert.deepEqual(
    { ...await restarting.api.renderAllMathInEditor(restarting.editor) },
    { ok: true, rendered: 1 }
  );
  assert.equal(attempts, 2);
  assert.equal(restarting.connectCount(), 2);
  assert.equal(restarting.ports[0].disconnectCalls, 0);
  assert.equal(restarting.ports[1].disconnectCalls, 1);

  const ordinaryFailure = loadComposeContent("$x$", {
    request() {
      return Promise.reject({ err: "Formula rejected." });
    }
  });
  assert.deepEqual(
    { ...await ordinaryFailure.api.renderAllMathInEditor(ordinaryFailure.editor) },
    { ok: false, rendered: 0 }
  );
  assert.equal(ordinaryFailure.connectCount(), 1);

  const malformed = loadComposeContent("$x$", {
    request() {
      return Promise.resolve({ dataUrl: "data:text/html;base64,iVBORw0KGgo=" });
    }
  });
  assert.deepEqual(
    { ...await malformed.api.renderAllMathInEditor(malformed.editor) },
    { ok: false, rendered: 0 }
  );

  const decoderFailure = loadComposeContent("$x$", {
    atob() {
      throw new Error("broken decoder");
    }
  });
  assert.throws(
    () => decoderFailure.api.requirePngDataUrl(
      "data:image/png;base64,iVBORw0KGgo="
    ),
    /invalid PNG data URL/i
  );

  const oversized = loadComposeContent("$x$", { imageWidth: 5000 });
  await assert.rejects(
    oversized.api.loadImage("data:image/png;base64,iVBORw0KGgo=", "$x$"),
    /dimensions/i
  );
  const broken = loadComposeContent("$x$", { imageError: true });
  await assert.rejects(
    broken.api.loadImage("data:image/png;base64,iVBORw0KGgo=", "$x$"),
    /could not be loaded/i
  );
});

test("Gmail toolbar restores formulas from every editing boundary", async () => {
  function deletion(inputType) {
    return {
      defaultPrevented: false,
      inputType,
      preventDefault() {
        this.defaultPrevented = true;
      },
      type: "beforeinput"
    };
  }

  const direct = loadComposeContent("$x$");
  await direct.api.renderAllMathInEditor(direct.editor);
  const directImage = direct.editor.querySelector(
    'img[data-tex-for-gmail-rendered="1"]'
  );
  const directOffset = direct.editor.childNodes.indexOf(directImage);
  direct.selection.addRange(
    direct.makeElementRange(direct.editor, directOffset + 1)
  );
  const backwards = deletion("deleteContentBackward");
  direct.editor.dispatchEvent(backwards);
  assert.equal(backwards.defaultPrevented, true);
  assert.equal(direct.editor.textContent, "$x$");

  const nested = loadComposeContent("$x$after");
  await nested.api.renderAllMathInEditor(nested.editor);
  const nestedImage = nested.editor.querySelector(
    'img[data-tex-for-gmail-rendered="1"]'
  );
  const after = nestedImage.nextSibling;
  const wrapper = nested.createElement("span");
  wrapper.append(nestedImage);
  nested.editor.insertBefore(wrapper, after);
  nested.selection.addRange(nested.makeRange(after, 0));
  const nestedDelete = deletion("deleteContentBackward");
  nested.editor.dispatchEvent(nestedDelete);
  assert.equal(nestedDelete.defaultPrevented, true);
  assert.match(nested.editor.textContent, /\$x\$/);

  const forward = loadComposeContent("$x$");
  await forward.api.renderAllMathInEditor(forward.editor);
  const forwardImage = forward.editor.querySelector(
    'img[data-tex-for-gmail-rendered="1"]'
  );
  const forwardOffset = forward.editor.childNodes.indexOf(forwardImage);
  forward.selection.addRange(
    forward.makeElementRange(forward.editor, forwardOffset)
  );
  const forwards = deletion("deleteContentForward");
  forward.editor.dispatchEvent(forwards);
  assert.equal(forwards.defaultPrevented, true);
  assert.equal(forward.selection.getRangeAt(0).startOffset, 0);

  const native = loadComposeContent("$x$", { nativeInsertText: true });
  await native.api.renderAllMathInEditor(native.editor);
  const nativeImage = native.editor.querySelector(
    'img[data-tex-for-gmail-rendered="1"]'
  );
  const nativeOffset = native.editor.childNodes.indexOf(nativeImage);
  native.selection.addRange(
    native.makeElementRange(native.editor, nativeOffset)
  );
  const inputsBefore = native.editorEvents.filter(
    event => event.type === "input"
  ).length;
  const nativeDelete = deletion("deleteContentForward");
  native.editor.dispatchEvent(nativeDelete);
  assert.equal(nativeDelete.defaultPrevented, true);
  assert.equal(native.selection.getRangeAt(0).startOffset, 0);
  assert.equal(
    native.editorEvents.filter(event => event.type === "input").length,
    inputsBefore + 1
  );

  const selected = loadComposeContent("$x$");
  await selected.api.renderAllMathInEditor(selected.editor);
  const selectedImage = selected.editor.querySelector(
    'img[data-tex-for-gmail-rendered="1"]'
  );
  const selectedOffset = selected.editor.childNodes.indexOf(selectedImage);
  selected.selection.addRange(
    selected.makeElementRange(selected.editor, selectedOffset, selectedOffset + 1)
  );
  const selectedDelete = deletion("deleteContentBackward");
  selected.editor.dispatchEvent(selectedDelete);
  assert.equal(selectedDelete.defaultPrevented, true);

  const doubleClick = loadComposeContent("$x$");
  await doubleClick.api.renderAllMathInEditor(doubleClick.editor);
  const doubleClickImage = doubleClick.editor.querySelector(
    'img[data-tex-for-gmail-rendered="1"]'
  );
  const click = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    target: {
      closest() {
        return doubleClickImage;
      }
    },
    type: "dblclick"
  };
  doubleClick.editor.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(doubleClick.editor.textContent, "$x$");

  const atStart = loadComposeContent("text");
  atStart.selection.addRange(atStart.makeRange(atStart.editor.childNodes[0], 0));
  const ordinaryDelete = deletion("deleteContentBackward");
  atStart.editor.dispatchEvent(ordinaryDelete);
  assert.equal(ordinaryDelete.defaultPrevented, false);
});

test("Gmail toolbar activation tracks dynamically added compose windows", async () => {
  const runtime = loadComposeContent("$x$");
  const button = runtime.toolbar.querySelector(
    "[data-tex-for-gmail-toolbar-button]"
  );
  button.dispatchEvent({ type: "click" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runtime.requests.map(request => request.source), ["x"]);

  const dynamic = runtime.createCompose("$y$");
  runtime.api.scheduleToolbarSync();
  runtime.api.scheduleToolbarSync();
  await Promise.resolve();
  assert.ok(dynamic.toolbar.querySelector("[data-tex-for-gmail-toolbar-button]"));

  const observed = runtime.createCompose("$z$");
  runtime.triggerMutation();
  await Promise.resolve();
  assert.ok(observed.toolbar.querySelector("[data-tex-for-gmail-toolbar-button]"));

  runtime.documentListeners.get("focusin")();
  await Promise.resolve();

  const noObserver = loadComposeContent("$x$", { noMutationObserver: true });
  assert.ok(noObserver.toolbar.querySelector("[data-tex-for-gmail-toolbar-button]"));
});
