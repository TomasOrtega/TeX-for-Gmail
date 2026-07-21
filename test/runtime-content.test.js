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
  const selectorQueries = [];
  const timers = [];
  const animationFrames = [];
  let connectCount = 0;
  let renderCacheHighWater = 0;
  let sourceTokenCounter = 0;

  class RuntimeMap extends Map {
    set(key, value) {
      const result = super.set(key, value);
      if (options.trackRenderCache &&
          typeof value === "string" &&
          value.startsWith("data:image/png;base64,"))
        renderCacheHighWater = Math.max(renderCacheHighWater, this.size);
      return result;
    }
  }

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
      if (node.nodeType === 11) {
        const replacements = [...node.childNodes];
        siblings.splice(index, 1, ...replacements);
        for (const replacement of replacements)
          replacement.parentNode = this.parentNode;
        node.childNodes = [];
      } else {
        siblings[index] = node;
        node.parentNode = this.parentNode;
      }
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

  class FakeDocumentFragment extends FakeNode {
    constructor() {
      super(11);
    }

    append(...nodes) {
      for (const node of nodes) {
        const child = typeof node === "string" ? new FakeText(node) : node;
        child.remove();
        child.parentNode = this;
        this.childNodes.push(child);
      }
    }

    get textContent() {
      return this.childNodes.map(node => node.textContent).join("");
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
      selectorQueries.push({ root: this, selector });
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

    replaceChildren(...nodes) {
      for (const child of this.childNodes)
        child.parentNode = undefined;
      this.childNodes = [];
      this.append(...nodes);
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
      const start = this.startContainer;
      const end = this.endContainer;
      if (start === end) {
        const after = new FakeText(start.data.slice(this.endOffset));
        start.data = start.data.slice(0, this.startOffset);
        this.after = after;
        start.parentNode.insertBefore(after, start.nextSibling);
      } else {
        const textNodes = descendants(document.documentElement).filter(
          node => node.nodeType === 3
        );
        const startIndex = textNodes.indexOf(start);
        const endIndex = textNodes.indexOf(end);
        start.data = start.data.slice(0, this.startOffset);
        end.data = end.data.slice(this.endOffset);
        for (let index = startIndex + 1; index < endIndex; index++)
          textNodes[index].data = "";
        this.after = start.nextSibling;
      }
      this.endContainer = start;
      this.endOffset = this.startOffset;
    }

    extractContents() {
      const fragment = new FakeDocumentFragment();
      const start = this.startContainer;
      const end = this.endContainer;
      if (start === end) {
        fragment.append(new FakeText(
          start.data.slice(this.startOffset, this.endOffset)
        ));
        this.deleteContents();
        return fragment;
      }

      if (start.parentNode === end.parentNode) {
        const parent = start.parentNode;
        const siblings = [...parent.childNodes];
        const startIndex = siblings.indexOf(start);
        const endIndex = siblings.indexOf(end);
        fragment.append(new FakeText(start.data.slice(this.startOffset)));
        for (const node of siblings.slice(startIndex + 1, endIndex))
          fragment.append(node);
        fragment.append(new FakeText(end.data.slice(0, this.endOffset)));
        start.data = start.data.slice(0, this.startOffset);
        end.data = end.data.slice(this.endOffset);
        this.after = end;
        this.endContainer = start;
        this.endOffset = this.startOffset;
        return fragment;
      }

      const textNodes = descendants(document.documentElement).filter(
        node => node.nodeType === 3
      );
      const startIndex = textNodes.indexOf(start);
      const endIndex = textNodes.indexOf(end);
      const selected = textNodes
        .slice(startIndex, endIndex + 1)
        .map((node, index, nodes) => {
          const from = index === 0 ? this.startOffset : 0;
          const to = index === nodes.length - 1
            ? this.endOffset
            : node.data.length;
          return node.data.slice(from, to);
        })
        .join("");
      fragment.append(new FakeText(selected));
      this.deleteContents();
      return fragment;
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
        const imageError = typeof options.imageError === "function"
          ? options.imageError(this)
          : options.imageError;
        const event = imageError ? "error" : "load";
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
          if (options.bootstrapRequest)
            return options.bootstrapRequest(message);
          if (options.bootstrapError)
            throw options.bootstrapError;
          return options.bootstrapResult || { ok: true };
        }
      }
    },
    clearTimeout() {},
    Communicator: class {
      constructor(port) {
        this.port = port;
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
    crypto: {
      randomUUID() {
        sourceTokenCounter++;
        return `00000000-0000-4000-8000-${
          sourceTokenCounter.toString(16).padStart(12, "0")
        }`;
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
    Map: RuntimeMap,
    Promise,
    queueMicrotask,
    requestAnimationFrame: options.noAnimationFrame ? undefined : callback => {
      animationFrames.push(callback);
      return animationFrames.length;
    },
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
        ? undefined : formattingAnchor,
      delimitedMathInEditor: typeof delimitedMathInEditor === "undefined"
        ? undefined : delimitedMathInEditor,
      expressionBoundary: typeof expressionBoundary === "undefined"
        ? undefined : expressionBoundary,
      markRenderedImage: typeof markRenderedImage === "undefined"
        ? undefined : markRenderedImage,
      rememberedRenderedSourceCount:
        typeof renderedSourcesByToken === "undefined"
          ? undefined : () => renderedSourcesByToken.size,
      sourceForRenderedImage: typeof sourceForRenderedImage === "undefined"
        ? undefined : sourceForRenderedImage
    })`, context),
    animationFrames,
    bold,
    bootstrapMessages,
    commands,
    connectCount: () => connectCount,
    additionalEditors,
    createCompose,
    createEditor,
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    dialog,
    document,
    documentListeners,
    editor,
    editorEvents,
    flushAnimationFrames() {
      for (const callback of animationFrames.splice(0))
        callback();
    },
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
    renderCacheHighWater: () => renderCacheHighWater,
    requests,
    selectorQueries,
    selection,
    toolbar,
    timers,
    triggerMutation(records = []) {
      mutationCallback?.(records);
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
  assert.match(
    image.dataset.texForGmailSourceToken,
    /^[0-9a-f-]{36}$/
  );
  assert.notEqual(image.dataset.texForGmailSourceToken, "$x^2$");
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

test("Gmail toolbar renders math split across inline formatting", async () => {
  const runtime = loadComposeContent("");
  const strong = runtime.createElement("strong");
  strong.append("^2 + y");
  runtime.editor.append("Before $x", strong, "$ and $z$ after.");

  assert.deepEqual(
    { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
    { ok: true, rendered: 2 }
  );
  assert.deepEqual(
    runtime.requests.map(request => request.source),
    ["x^2 + y", "z"]
  );

  const images = runtime.editor.querySelectorAll(
    'img[data-tex-for-gmail-rendered="1"]'
  );
  assert.equal(images.length, 2);
  runtime.editor.dispatchEvent({
    preventDefault() {},
    target: images[0],
    type: "dblclick"
  });
  assert.match(runtime.editor.textContent, /\$x\^2 \+ y\$/);
});

test("Gmail toolbar restores cross-node markup after a render failure",
  async () => {
    const runtime = loadComposeContent("", {
      request() {
        return Promise.reject({ err: "Formula rejected." });
      }
    });
    const strong = runtime.createElement("strong");
    const emphasis = runtime.createElement("em");
    strong.append("^2");
    emphasis.append(" + y");
    runtime.editor.append("Before $x", strong, emphasis, "$ after.");

    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: false, rendered: 0 }
    );
    assert.equal(runtime.editor.textContent, "Before $x^2 + y$ after.");
    assert.equal(runtime.editor.querySelector("strong").textContent, "^2");
    assert.equal(runtime.editor.querySelector("em").textContent, " + y");
    assert.equal(strong.parentNode, runtime.editor);
    assert.equal(strong.nextSibling, emphasis);
    assert.equal(emphasis.parentNode, runtime.editor);
  });

test("Gmail toolbar restores Gmail line markup after a render failure",
  async () => {
    const runtime = loadComposeContent("", {
      request() {
        return Promise.reject({ err: "Formula rejected." });
      }
    });
    const line = runtime.createElement("div");
    const strong = runtime.createElement("strong");
    const lineBreak = runtime.createElement("br");
    const emphasis = runtime.createElement("em");
    strong.append("^2");
    emphasis.append(" + y");
    line.append(strong, lineBreak, emphasis);
    runtime.editor.append("Before $$x", line, "$$ after.");

    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: false, rendered: 0 }
    );
    assert.equal(runtime.editor.textContent, "Before $$x^2 + y$$ after.");
    assert.equal(line.parentNode, runtime.editor);
    assert.deepEqual(line.childNodes, [strong, lineBreak, emphasis]);
    assert.equal(strong.textContent, "^2");
    assert.equal(emphasis.textContent, " + y");
  });

test("Gmail toolbar replaces multiline math without empty Gmail lines",
  async () => {
    const runtime = loadComposeContent("");
    const firstLine = runtime.createElement("div");
    const secondLine = runtime.createElement("div");
    const afterLine = runtime.createElement("div");
    firstLine.append("$$x");
    secondLine.append("+y$$");
    afterLine.append("after");
    runtime.editor.textContent = "";
    runtime.editor.append(firstLine, secondLine, afterLine);

    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: true, rendered: 1 }
    );
    assert.deepEqual(runtime.editor.childNodes, [firstLine, afterLine]);
    assert.ok(firstLine.querySelector(
      'img[data-tex-for-gmail-rendered="1"]'
    ));
    assert.equal(firstLine.textContent, "");
    assert.equal(secondLine.parentNode, undefined);
    assert.equal(afterLine.textContent, "after");
  });

test("Gmail toolbar restores exact multiline Gmail lines after failure",
  async () => {
    const runtime = loadComposeContent("", {
      request() {
        return Promise.reject({ err: "Formula rejected." });
      }
    });
    const firstLine = runtime.createElement("div");
    const secondLine = runtime.createElement("div");
    const afterLine = runtime.createElement("div");
    const firstText = runtime.document.createTextNode("$$x");
    const secondText = runtime.document.createTextNode("+y$$");
    firstLine.append(firstText);
    secondLine.append(secondText);
    afterLine.append("after");
    runtime.editor.textContent = "";
    runtime.editor.append(firstLine, secondLine, afterLine);

    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: false, rendered: 0 }
    );
    assert.deepEqual(
      runtime.editor.childNodes,
      [firstLine, secondLine, afterLine]
    );
    assert.deepEqual(firstLine.childNodes, [firstText]);
    assert.deepEqual(secondLine.childNodes, [secondText]);
    assert.equal(firstText.data, "$$x");
    assert.equal(secondText.data, "+y$$");
    assert.equal(afterLine.textContent, "after");
  });

test("Gmail toolbar keeps changed multiline math without empty lines",
  async () => {
    let resolveRender;
    const runtime = loadComposeContent("", {
      request() {
        return new Promise(resolve => {
          resolveRender = resolve;
        });
      }
    });
    const firstLine = runtime.createElement("div");
    const secondLine = runtime.createElement("div");
    const afterLine = runtime.createElement("div");
    firstLine.append("$$x");
    secondLine.append("+y$$");
    afterLine.append("after");
    runtime.editor.textContent = "";
    runtime.editor.append(firstLine, secondLine, afterLine);

    const rendering = runtime.api.renderAllMathInEditor(runtime.editor);
    await new Promise(resolve => setImmediate(resolve));
    const pending = runtime.editor.querySelector(
      "[data-tex-for-gmail-pending]"
    );
    pending.textContent = "$z$";
    resolveRender({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" });

    assert.deepEqual(
      { ...await rendering },
      { ok: true, rendered: 0 }
    );
    assert.deepEqual(runtime.editor.childNodes, [firstLine, afterLine]);
    assert.equal(firstLine.textContent, "$z$");
    assert.equal(
      runtime.editor.querySelector("[data-tex-for-gmail-pending]"),
      undefined
    );
    assert.equal(secondLine.parentNode, undefined);
  });

test("Gmail toolbar does not restore removed multiline pending math",
  async () => {
    let rejectRender;
    const runtime = loadComposeContent("", {
      request() {
        return new Promise((_resolve, reject) => {
          rejectRender = reject;
        });
      }
    });
    const firstLine = runtime.createElement("div");
    const secondLine = runtime.createElement("div");
    const afterLine = runtime.createElement("div");
    firstLine.append("$$x");
    secondLine.append("+y$$");
    afterLine.append("after");
    runtime.editor.textContent = "";
    runtime.editor.append(firstLine, secondLine, afterLine);

    const rendering = runtime.api.renderAllMathInEditor(runtime.editor);
    await new Promise(resolve => setImmediate(resolve));
    runtime.editor.querySelector("[data-tex-for-gmail-pending]").remove();
    rejectRender(new Error("Renderer failed."));

    assert.deepEqual(
      { ...await rendering },
      { ok: false, rendered: 0 }
    );
    assert.deepEqual(runtime.editor.childNodes, [firstLine, afterLine]);
    assert.equal(firstLine.textContent, "");
    assert.equal(secondLine.parentNode, undefined);
  });

test("Gmail toolbar renders multiline AMS math across Gmail line markup",
  async () => {
    const runtime = loadComposeContent("");
    const firstLine = runtime.createElement("div");
    const secondLine = runtime.createElement("div");
    const lineBreak = runtime.createElement("br");
    firstLine.append(
      String.raw`x &= 1 \\`,
      lineBreak,
      String.raw`y &= 2`
    );
    secondLine.append(String.raw`\end{aligned}$$`);
    runtime.editor.append(
      String.raw`$$\begin{aligned}`,
      firstLine,
      secondLine
    );

    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: true, rendered: 1 }
    );
    const original = [
      String.raw`$$\begin{aligned}`,
      String.raw`x &= 1 \\`,
      String.raw`y &= 2`,
      String.raw`\end{aligned}$$`
    ].join("\n");
    assert.deepEqual(runtime.requests.map(request => ({
      display: request.display,
      source: request.source
    })), [{
      display: true,
      source: original.slice(2, -2)
    }]);
    const image = runtime.editor.querySelector(
      'img[data-tex-for-gmail-rendered="1"]'
    );
    assert.equal(
      image.className,
      "tex-for-gmail-image tex-for-gmail-display"
    );
    runtime.editor.dispatchEvent({
      preventDefault() {},
      target: image,
      type: "dblclick"
    });
    assert.equal(runtime.editor.textContent, original);
  });

test("Gmail toolbar does not join math across headings", async () => {
  const runtime = loadComposeContent("");
  const heading = runtime.createElement("h2");
  heading.append("$inside$");
  runtime.editor.append("$outside", heading, "outside$");

  assert.deepEqual(
    { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
    { ok: true, rendered: 1 }
  );
  assert.deepEqual(runtime.requests.map(request => request.source), ["inside"]);
  assert.equal(runtime.editor.textContent, "$outsideoutside$");
  assert.ok(
    heading.querySelector('img[data-tex-for-gmail-rendered="1"]')
  );
});

test("Gmail toolbar does not join math across table cells or rows",
  async () => {
    const runtime = loadComposeContent("");
    const table = runtime.createElement("table");
    const body = runtime.createElement("tbody");
    const firstRow = runtime.createElement("tr");
    const firstCell = runtime.createElement("td");
    const secondCell = runtime.createElement("td");
    const secondRow = runtime.createElement("tr");
    const thirdCell = runtime.createElement("td");
    firstCell.append("$left");
    secondCell.append("right$");
    thirdCell.append("$inside$");
    firstRow.append(firstCell, secondCell);
    secondRow.append(thirdCell);
    body.append(firstRow, secondRow);
    table.append(body);
    runtime.editor.append(table);

    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: true, rendered: 1 }
    );
    assert.deepEqual(runtime.requests.map(request => request.source), ["inside"]);
    assert.equal(firstCell.textContent, "$left");
    assert.equal(secondCell.textContent, "right$");
    assert.ok(
      thirdCell.querySelector('img[data-tex-for-gmail-rendered="1"]')
    );
  });

test("Gmail toolbar does not join math across list items or paragraphs",
  async () => {
    const runtime = loadComposeContent("");
    const list = runtime.createElement("ul");
    const firstItem = runtime.createElement("li");
    const secondItem = runtime.createElement("li");
    const thirdItem = runtime.createElement("li");
    const firstParagraph = runtime.createElement("p");
    const secondParagraph = runtime.createElement("p");
    const thirdParagraph = runtime.createElement("p");
    firstItem.append("$$list");
    secondItem.append("cross$$");
    thirdItem.append("$$inside-list$$");
    firstParagraph.append("$$paragraph");
    secondParagraph.append("cross$$");
    thirdParagraph.append("$$inside-paragraph$$");
    list.append(firstItem, secondItem, thirdItem);
    runtime.editor.append(
      list,
      firstParagraph,
      secondParagraph,
      thirdParagraph
    );

    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: true, rendered: 2 }
    );
    assert.deepEqual(
      runtime.requests.map(request => request.source),
      ["inside-list", "inside-paragraph"]
    );
    assert.equal(firstItem.textContent, "$$list");
    assert.equal(secondItem.textContent, "cross$$");
    assert.ok(
      thirdItem.querySelector('img[data-tex-for-gmail-rendered="1"]')
    );
    assert.equal(firstParagraph.textContent, "$$paragraph");
    assert.equal(secondParagraph.textContent, "cross$$");
    assert.ok(
      thirdParagraph.querySelector('img[data-tex-for-gmail-rendered="1"]')
    );
  });

test("Gmail toolbar keeps unsafe content outside logical math streams",
  async () => {
    const runtime = loadComposeContent("");
    const quote = runtime.createElement("blockquote");
    quote.append("$quoted$");
    const gmailQuote = runtime.createElement("span");
    gmailQuote.className = "gmail_quote";
    gmailQuote.append("$gmail$");
    const locked = runtime.createElement("span");
    locked.setAttribute("contenteditable", "false");
    locked.append("$locked$");
    const pending = runtime.createElement("span");
    pending.dataset.texForGmailPending = "1";
    pending.append("$pending$");
    const rendered = runtime.createElement("span");
    rendered.dataset.texForGmailRendered = "1";
    rendered.append("$rendered$");
    const atomic = runtime.createElement("img");
    runtime.editor.append(
      "$first$",
      quote,
      gmailQuote,
      locked,
      pending,
      rendered,
      String.raw`\(`,
      atomic,
      String.raw`crossed\)`,
      "$last$"
    );

    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: true, rendered: 2 }
    );
    assert.deepEqual(
      runtime.requests.map(request => request.source),
      ["first", "last"]
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

  const detachedToolbar = shared.createElement("div");
  detachedToolbar.setAttribute("role", "toolbar");
  const detachedBold = shared.createElement("div");
  detachedBold.setAttribute("command", "+bold");
  detachedToolbar.append(detachedBold);
  assert.equal(
    shared.api.formattingAnchor(shared.editor, [detachedBold]),
    undefined
  );

  const unrelated = loadComposeContent("$x$", {
    boldOutsideToolbar: true,
    withToolbar: false
  });
  assert.equal(unrelated.dialog.querySelector(buttonSelector), undefined);
  assert.equal(unrelated.api.formattingAnchor(unrelated.editor), undefined);

  const duplicate = loadComposeContent("$x$");
  const duplicateBold = duplicate.createElement("div");
  duplicateBold.setAttribute("command", "+bold");
  duplicate.toolbar.append(duplicateBold);
  assert.equal(duplicate.api.formattingAnchor(duplicate.editor), undefined);
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

test("Gmail toolbar scopes active renders to each compose editor", async () => {
  let resolveSlowRender;
  const runtime = loadComposeContent("$slow$", {
    additionalSources: ["$fast$"],
    request(request) {
      if (request.source === "slow") {
        return new Promise(resolve => {
          resolveSlowRender = resolve;
        });
      }
      return Promise.resolve({
        dataUrl: "data:image/png;base64,iVBORw0KGgo="
      });
    }
  });
  const fastEditor = runtime.additionalEditors[0];

  const slowRendering = runtime.api.renderAllMathInEditor(runtime.editor);
  const fastRendering = runtime.api.renderAllMathInEditor(fastEditor);
  assert.deepEqual(
    { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
    { ok: false, error: "A LaTeX render is already in progress." }
  );

  const fastResult = { ...await fastRendering };
  const disconnectsWhileSlow = runtime.ports[0].disconnectCalls;

  resolveSlowRender({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" });
  const slowResult = { ...await slowRendering };

  assert.deepEqual(fastResult, { ok: true, rendered: 1 });
  assert.deepEqual(slowResult, { ok: true, rendered: 1 });
  assert.deepEqual(
    runtime.requests.map(request => request.source),
    ["slow", "fast"]
  );
  assert.equal(runtime.connectCount(), 1);
  assert.equal(disconnectsWhileSlow, 0);
  assert.equal(runtime.ports[0].disconnectCalls, 1);
});

test("Gmail toolbar restores formulas when renderer initialization fails",
  async () => {
    const runtime = loadComposeContent("$x$", {
      bootstrapResult: { error: "Renderer unavailable.", ok: false }
    });

    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: false, rendered: 0 }
    );
    assert.equal(runtime.connectCount(), 0);
    assert.equal(runtime.requests.length, 0);
    assert.equal(runtime.editor.textContent, "$x$");
  });

test("Gmail toolbar skips a changed formula before its renderer request",
  async () => {
    let resolveBootstrap;
    const runtime = loadComposeContent("$x$", {
      bootstrapRequest() {
        return new Promise(resolve => {
          resolveBootstrap = resolve;
        });
      }
    });

    const rendering = runtime.api.renderAllMathInEditor(runtime.editor);
    await new Promise(resolve => setImmediate(resolve));
    runtime.editor.querySelector("[data-tex-for-gmail-pending]")
      .textContent = "$y$";
    resolveBootstrap({ ok: true });

    assert.deepEqual(
      { ...await rendering },
      { ok: true, rendered: 0 }
    );
    assert.equal(runtime.requests.length, 0);
    assert.equal(runtime.editor.textContent, "$y$");
    assert.equal(
      runtime.editor.querySelector("[data-tex-for-gmail-pending]"),
      undefined
    );
  });

test("Gmail toolbar stops a detached compose batch before another request",
  async () => {
    let attempts = 0;
    let resolveFirstRender;
    const runtime = loadComposeContent("$first$ $second$ $third$", {
      request() {
        attempts++;
        if (attempts > 1) {
          return Promise.resolve({
            dataUrl: "data:image/png;base64,iVBORw0KGgo="
          });
        }
        return new Promise(resolve => {
          resolveFirstRender = resolve;
        });
      }
    });

    const rendering = runtime.api.renderAllMathInEditor(runtime.editor);
    await new Promise(resolve => setImmediate(resolve));
    runtime.dialog.remove();
    resolveFirstRender({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" });

    assert.deepEqual(
      { ...await rendering },
      { ok: false, rendered: 0 }
    );
    assert.deepEqual(
      runtime.requests.map(request => request.source),
      ["first"]
    );
    assert.equal(runtime.editor.textContent, "$first$ $second$ $third$");
    assert.equal(
      runtime.editor.querySelector("[data-tex-for-gmail-pending]"),
      undefined
    );
    assert.equal(runtime.editorEvents.length, 0);
  });

test("Gmail toolbar does not retry a restarting renderer after detachment",
  async () => {
    let attempts = 0;
    let runtime;
    runtime = loadComposeContent("$x$", {
      request(_request, port) {
        attempts++;
        runtime.dialog.remove();
        for (const listener of port.onDisconnect.listeners)
          listener();
        return Promise.reject({ err: "Communication target disconnected." });
      }
    });

    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: false, rendered: 0 }
    );
    assert.equal(attempts, 1);
    assert.equal(runtime.connectCount(), 1);
    assert.equal(runtime.editor.textContent, "$x$");
    assert.equal(
      runtime.editor.querySelector("[data-tex-for-gmail-pending]"),
      undefined
    );
  });

test("Gmail toolbar does not notify a detached editor after a partial batch",
  async () => {
    let attempts = 0;
    let resolveSecondRender;
    const runtime = loadComposeContent("$first$ $second$ $third$", {
      request() {
        attempts++;
        if (attempts === 2) {
          return new Promise(resolve => {
            resolveSecondRender = resolve;
          });
        }
        return Promise.resolve({
          dataUrl: "data:image/png;base64,iVBORw0KGgo="
        });
      }
    });

    const rendering = runtime.api.renderAllMathInEditor(runtime.editor);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(
      runtime.requests.map(request => request.source),
      ["first", "second"]
    );
    runtime.dialog.remove();
    resolveSecondRender({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" });

    assert.deepEqual(
      { ...await rendering },
      { ok: false, rendered: 1 }
    );
    assert.deepEqual(
      runtime.requests.map(request => request.source),
      ["first", "second"]
    );
    assert.equal(runtime.editorEvents.length, 0);
    assert.equal(
      runtime.editor.querySelector("[data-tex-for-gmail-pending]"),
      undefined
    );
  });

test("Gmail toolbar caches successful duplicate renders within one batch",
  async () => {
    const runtime = loadComposeContent(
      String.raw`$x$ then \(x\) and $$x$$`,
      { trackRenderCache: true }
    );

    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: true, rendered: 3 }
    );
    assert.deepEqual(
      runtime.requests.map(request => ({
        display: request.display,
        source: request.source
      })),
      [
        { display: false, source: "x" },
        { display: true, source: "x" }
      ]
    );
    const images = runtime.editor.querySelectorAll(
      'img[data-tex-for-gmail-rendered="1"]'
    );
    assert.equal(images.length, 3);
    assert.notEqual(images[0], images[1]);
    assert.notEqual(
      images[0].dataset.texForGmailSourceToken,
      images[1].dataset.texForGmailSourceToken
    );
    assert.equal(runtime.renderCacheHighWater(), 1);
  });

test("Gmail toolbar does not cache failed results or later batches",
  async () => {
    let attempts = 0;
    const runtime = loadComposeContent("$x$ and $x$", {
      request() {
        attempts++;
        if (attempts === 1)
          return Promise.reject(new Error("Renderer failed."));
        return Promise.resolve({
          dataUrl: "data:image/png;base64,iVBORw0KGgo="
        });
      }
    });

    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: false, rendered: 1 }
    );
    assert.equal(attempts, 2);

    runtime.editor.textContent = "$x$";
    assert.deepEqual(
      { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
      { ok: true, rendered: 1 }
    );
    assert.equal(attempts, 3);

    let imageLoads = 0;
    const imageFailure = loadComposeContent("$y$ and $y$", {
      imageError() {
        imageLoads++;
        return imageLoads === 1;
      }
    });
    assert.deepEqual(
      { ...await imageFailure.api.renderAllMathInEditor(imageFailure.editor) },
      { ok: false, rendered: 1 }
    );
    assert.equal(imageFailure.requests.length, 2);
  });

test("Gmail toolbar preserves a changed duplicate awaiting a shared result",
  async () => {
    let attempts = 0;
    let resolveRender;
    const runtime = loadComposeContent("$x$ and $x$", {
      request() {
        attempts++;
        if (attempts > 1) {
          return Promise.resolve({
            dataUrl: "data:image/png;base64,iVBORw0KGgo="
          });
        }
        return new Promise(resolve => {
          resolveRender = resolve;
        });
      }
    });

    const rendering = runtime.api.renderAllMathInEditor(runtime.editor);
    await new Promise(resolve => setImmediate(resolve));
    const pending = runtime.editor.querySelectorAll(
      "[data-tex-for-gmail-pending]"
    );
    assert.equal(pending.length, 2);
    pending[1].textContent = "$y$";
    resolveRender({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" });

    assert.deepEqual(
      { ...await rendering },
      { ok: true, rendered: 1 }
    );
    assert.equal(runtime.requests.length, 1);
    assert.equal(runtime.editor.textContent, " and $y$");
    assert.equal(
      runtime.editor.querySelector("[data-tex-for-gmail-pending]"),
      undefined
    );
  });

test("Gmail toolbar leaves excess formulas for the next batch", async () => {
  const source = Array.from({ length: 51 }, (_value, index) =>
    `$x_${index}$`
  ).join(" ");
  const runtime = loadComposeContent(source, { trackRenderCache: true });

  assert.deepEqual(
    { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
    { ok: false, rendered: 50 }
  );
  assert.equal(runtime.requests.length, 50);
  assert.equal(runtime.requests[0].source, "x_0");
  assert.equal(runtime.requests.at(-1).source, "x_49");
  assert.equal(runtime.renderCacheHighWater(), 0);
  assert.match(
    runtime.document.querySelector("#tex-for-gmail-status").textContent,
    /Batch limit reached/
  );
  assert.deepEqual(
    { ...await runtime.api.renderAllMathInEditor(runtime.editor) },
    { ok: true, rendered: 1 }
  );
  assert.equal(runtime.requests.at(-1).source, "x_50");
});

test("math discovery stops after the batch lookahead", () => {
  const runtime = loadComposeContent("");
  const firstStream = runtime.createElement("p");
  firstStream.textContent = Array.from({ length: 51 }, (_value, index) =>
    `$x_${index}$`
  ).join(" ");
  const unvisitedStream = runtime.createElement("p");
  Object.defineProperty(unvisitedStream, "childNodes", {
    get() {
      throw new Error("scanned beyond the batch lookahead");
    }
  });
  runtime.editor.replaceChildren(firstStream, unvisitedStream);

  const result = runtime.api.delimitedMathInEditor(runtime.editor);

  assert.equal(result.expressions.length, 50);
  assert.equal(result.truncated, true);
  assert.equal(result.expressions.at(-1).text, "$x_49$");
});

test("ordered expression boundaries advance through segments once", () => {
  const runtime = loadComposeContent("");
  const segments = Array.from({ length: 100 }, (_value, index) => ({
    end: index * 3 + 3,
    node: { index },
    start: index * 3
  }));
  let segmentReads = 0;
  const stream = {
    segments: new Proxy(segments, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property))
          segmentReads++;
        return Reflect.get(target, property, receiver);
      }
    })
  };
  const cursor = { index: 0 };

  for (let index = 0; index < 100; index++) {
    assert.equal(
      runtime.api.expressionBoundary(stream, index * 3, false, cursor).node,
      segments[index].node
    );
    assert.equal(
      runtime.api.expressionBoundary(stream, index * 3 + 3, true, cursor).node,
      segments[index].node
    );
  }

  assert.ok(segmentReads <= 300, `${segmentReads} segment reads`);
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

test("Gmail toolbar restores formulas after rendered images are cloned", async () => {
  function replaceWithClone(runtime, image) {
    const clone = runtime.createElement("img");
    Object.assign(clone.dataset, image.dataset);
    image.replaceWith(clone);
    return clone;
  }

  const doubleClick = loadComposeContent("$x^2$");
  await doubleClick.api.renderAllMathInEditor(doubleClick.editor);
  const original = doubleClick.editor.querySelector(
    'img[data-tex-for-gmail-rendered="1"]'
  );
  const clone = replaceWithClone(doubleClick, original);
  const click = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    target: clone,
    type: "dblclick"
  };
  doubleClick.editor.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(doubleClick.editor.textContent, "$x^2$");

  const deletion = loadComposeContent("$y$");
  await deletion.api.renderAllMathInEditor(deletion.editor);
  const deletionOriginal = deletion.editor.querySelector(
    'img[data-tex-for-gmail-rendered="1"]'
  );
  const deletionClone = replaceWithClone(deletion, deletionOriginal);
  const offset = deletion.editor.childNodes.indexOf(deletionClone);
  deletion.selection.addRange(
    deletion.makeElementRange(deletion.editor, offset + 1)
  );
  const backwards = {
    defaultPrevented: false,
    inputType: "deleteContentBackward",
    preventDefault() {
      this.defaultPrevented = true;
    },
    type: "beforeinput"
  };
  deletion.editor.dispatchEvent(backwards);
  assert.equal(backwards.defaultPrevented, true);
  assert.equal(deletion.editor.textContent, "$y$");
});

test("Gmail toolbar validates and bounds remembered formula sources", async () => {
  const runtime = loadComposeContent("");
  const first = runtime.createElement("img");
  runtime.api.markRenderedImage(first, "$x_0$");
  const firstToken = first.dataset.texForGmailSourceToken;

  const malformed = runtime.createElement("img");
  malformed.dataset.texForGmailRendered = "1";
  malformed.dataset.texForGmailSourceToken = "__proto__";
  assert.equal(runtime.api.sourceForRenderedImage(malformed), undefined);

  const unknown = runtime.createElement("img");
  unknown.dataset.texForGmailRendered = "1";
  unknown.dataset.texForGmailSourceToken =
    "ffffffff-ffff-4fff-bfff-ffffffffffff";
  assert.equal(runtime.api.sourceForRenderedImage(unknown), undefined);

  assert.throws(
    () => runtime.api.markRenderedImage(
      runtime.createElement("img"),
      "x".repeat(latex.MAX_SOURCE_LENGTH + 1)
    ),
    /size limit/
  );

  for (let index = 1; index <= 500; index++) {
    runtime.api.markRenderedImage(
      runtime.createElement("img"),
      `$x_${index}$`
    );
  }
  assert.equal(runtime.api.rememberedRenderedSourceCount(), 500);
  assert.equal(runtime.api.sourceForRenderedImage(first), "$x_0$");

  const evictedClone = runtime.createElement("img");
  evictedClone.dataset.texForGmailRendered = "1";
  evictedClone.dataset.texForGmailSourceToken = firstToken;
  assert.equal(runtime.api.sourceForRenderedImage(evictedClone), undefined);
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
  runtime.api.scheduleToolbarSync(dynamic.dialog);
  runtime.api.scheduleToolbarSync(dynamic.dialog);
  runtime.flushAnimationFrames();
  assert.ok(dynamic.toolbar.querySelector("[data-tex-for-gmail-toolbar-button]"));

  const observed = runtime.createCompose("$z$");
  runtime.triggerMutation([{
    addedNodes: [observed.dialog],
    removedNodes: [],
    target: runtime.document.body,
    type: "childList"
  }]);
  runtime.flushAnimationFrames();
  assert.ok(observed.toolbar.querySelector("[data-tex-for-gmail-toolbar-button]"));

  runtime.documentListeners.get("focusin")({ target: observed.editor });
  runtime.flushAnimationFrames();

  const outsideCompose = runtime.createElement("input");
  runtime.document.documentElement.append(outsideCompose);
  runtime.documentListeners.get("focusin")({ target: outsideCompose });
  assert.equal(runtime.animationFrames.length, 0);

  const noObserver = loadComposeContent("$x$", { noMutationObserver: true });
  assert.ok(noObserver.toolbar.querySelector("[data-tex-for-gmail-toolbar-button]"));
  const focusActivated = noObserver.createCompose("$focus$");
  noObserver.documentListeners.get("focusin")({ target: focusActivated.editor });
  noObserver.flushAnimationFrames();
  assert.ok(focusActivated.toolbar.querySelector(
    "[data-tex-for-gmail-toolbar-button]"
  ));

  const fallback = loadComposeContent("$x$", { noAnimationFrame: true });
  const fallbackDynamic = fallback.createCompose("$fallback$");
  fallback.api.scheduleToolbarSync(fallbackDynamic.dialog);
  await Promise.resolve();
  assert.ok(fallbackDynamic.toolbar.querySelector(
    "[data-tex-for-gmail-toolbar-button]"
  ));
});

test("Gmail toolbar ignores extension-owned editor and status mutations",
  async () => {
    const runtime = loadComposeContent("$x$");
    const pending = runtime.createElement("span");
    pending.dataset.texForGmailPending = "1";
    const image = runtime.createElement("img");
    image.dataset.texForGmailRendered = "1";
    const status = runtime.createElement("div");
    status.id = "tex-for-gmail-status";
    const installedButton = runtime.toolbar.querySelector(
      "[data-tex-for-gmail-toolbar-button]"
    );
    runtime.editor.append(pending);
    runtime.document.documentElement.append(status);
    runtime.selectorQueries.length = 0;

    const records = [
      {
        addedNodes: [pending],
        removedNodes: [],
        target: runtime.editor,
        type: "childList"
      },
      {
        addedNodes: [image],
        removedNodes: [pending],
        target: runtime.editor,
        type: "childList"
      },
      {
        addedNodes: [status],
        removedNodes: [],
        target: runtime.document.documentElement,
        type: "childList"
      },
      {
        addedNodes: [],
        removedNodes: [],
        target: status,
        type: "childList"
      },
      {
        addedNodes: [installedButton],
        removedNodes: [],
        target: runtime.toolbar,
        type: "childList"
      }
    ];
    for (let turn = 0; turn < 100; turn++) {
      runtime.triggerMutation(records);
      await Promise.resolve();
    }

    assert.equal(runtime.animationFrames.length, 0);
    assert.equal(runtime.selectorQueries.length, 0);
  });

test("Gmail toolbar coalesces and scopes compose reconciliation", async () => {
  const runtime = loadComposeContent("$initial$");
  const unobserved = runtime.createCompose("$unobserved$");
  const first = runtime.createCompose("$first$");
  const second = runtime.createCompose("$second$");
  runtime.selectorQueries.length = 0;

  runtime.triggerMutation([{
    addedNodes: [first.dialog],
    removedNodes: [],
    target: runtime.document.body,
    type: "childList"
  }]);
  runtime.triggerMutation([{
    addedNodes: [second.dialog],
    removedNodes: [],
    target: runtime.document.body,
    type: "childList"
  }]);

  assert.equal(runtime.animationFrames.length, 1);
  runtime.flushAnimationFrames();
  const globalQueries = runtime.selectorQueries.filter(query =>
    query.root === runtime.document.documentElement
  );

  assert.ok(first.toolbar.querySelector(
    "[data-tex-for-gmail-toolbar-button]"
  ));
  assert.ok(second.toolbar.querySelector(
    "[data-tex-for-gmail-toolbar-button]"
  ));
  assert.equal(unobserved.toolbar.querySelector(
    "[data-tex-for-gmail-toolbar-button]"
  ), undefined);
  assert.deepEqual(globalQueries, []);
});

test("Gmail toolbar rebinds a retained button after its editor is replaced",
  async () => {
    const runtime = loadComposeContent("$old$");
    const selector = "[data-tex-for-gmail-toolbar-button]";
    const staleButton = runtime.toolbar.querySelector(selector);
    const replacement = runtime.createEditor("$new$");
    runtime.editor.replaceWith(replacement);

    runtime.triggerMutation([{
      addedNodes: [replacement],
      removedNodes: [runtime.editor],
      target: runtime.dialog,
      type: "childList"
    }]);
    runtime.flushAnimationFrames();
    const button = runtime.toolbar.querySelector(selector);

    assert.notEqual(button, staleButton);
    assert.equal(staleButton.isConnected, false);
    assert.equal(replacement.listeners.get("beforeinput")?.length, 1);
    assert.equal(replacement.listeners.get("dblclick")?.length, 1);
    assert.equal(button.listeners.get("mousedown")?.length, 1);
    assert.equal(button.listeners.get("click")?.length, 1);

    runtime.api.syncGmailToolbars();
    assert.equal(runtime.toolbar.querySelector(selector), button);
    assert.equal(replacement.listeners.get("beforeinput")?.length, 1);
    assert.equal(replacement.listeners.get("dblclick")?.length, 1);
    assert.equal(button.listeners.get("click")?.length, 1);

    button.dispatchEvent({ type: "click" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(runtime.requests.map(request => request.source), ["new"]);
  });

test("Gmail toolbar repairs cloned and removed buttons", async () => {
  const runtime = loadComposeContent("$x$");
  const selector = "[data-tex-for-gmail-toolbar-button]";
  const dynamic = runtime.createCompose("$y$");
  const clone = runtime.createElement("button");
  clone.dataset.texForGmailToolbarButton = "1";
  clone.textContent = "∑";
  dynamic.toolbar.insertBefore(clone, dynamic.bold.nextSibling);

  runtime.triggerMutation([{
    addedNodes: [clone],
    removedNodes: [],
    target: dynamic.toolbar,
    type: "childList"
  }]);
  runtime.flushAnimationFrames();
  const button = dynamic.toolbar.querySelector(selector);

  assert.notEqual(button, clone);
  assert.equal(clone.isConnected, false);
  assert.equal(dynamic.toolbar.querySelectorAll(selector).length, 1);
  assert.equal(dynamic.editor.listeners.get("beforeinput")?.length, 1);
  assert.equal(dynamic.editor.listeners.get("dblclick")?.length, 1);
  assert.equal(button.listeners.get("mousedown")?.length, 1);
  assert.equal(button.listeners.get("click")?.length, 1);

  button.remove();
  runtime.triggerMutation([{
    addedNodes: [],
    removedNodes: [button],
    target: dynamic.toolbar,
    type: "childList"
  }]);
  runtime.flushAnimationFrames();
  const replacement = dynamic.toolbar.querySelector(selector);
  assert.notEqual(replacement, button);
  assert.equal(replacement.listeners.get("click")?.length, 1);

  replacement.dispatchEvent({ type: "click" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runtime.requests.map(request => request.source), ["y"]);
});
