"use strict";

const extensionApi = globalThis.browser || globalThis.chrome;
const RENDER_SCALE = 2;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_PNG_BASE64_LENGTH = Math.ceil(MAX_PNG_BYTES / 3) * 4;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const RENDER_PORT_NAME = "tex-for-gmail-render";
const RENDERER_RESTARTING_ERROR = "The renderer is restarting.";
const GMAIL_EDITOR_SELECTOR =
  '[g_editable="true"][contenteditable="true"][role="textbox"]';
const GMAIL_BOLD_SELECTOR = '[command="+bold"], [command="bold"]';
const RENDERED_IMAGE_SELECTOR = 'img[data-tex-for-gmail-rendered="1"]';
const TOOLBAR_BUTTON_SELECTOR = '[data-tex-for-gmail-toolbar-button]';
const MATH_EXCLUDED_SELECTOR =
  '[contenteditable="false"], blockquote, .gmail_quote, ' +
  '[data-tex-for-gmail-pending], [data-tex-for-gmail-rendered]';
const RENDERED_SOURCE_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MATH_LINE_BREAK_TAGS = new Set(["DIV", "LI", "P", "PRE"]);
const MATH_STREAM_BARRIER_TAGS = new Set([
  "AREA",
  "AUDIO",
  "BUTTON",
  "CANVAS",
  "EMBED",
  "HR",
  "IFRAME",
  "IMG",
  "INPUT",
  "OBJECT",
  "SCRIPT",
  "SELECT",
  "STYLE",
  "TEXTAREA",
  "VIDEO"
]);
const MAX_BATCH_EXPRESSIONS = 50;
const MAX_REMEMBERED_RENDERED_SOURCES = 500;
let rendererConnection;
let statusTimer;
let renderInProgress = false;
let toolbarRefreshQueued = false;
const configuredEditors = new WeakSet();
const renderedSources = new WeakMap();
const renderedSourcesByToken = new Map();

async function getCommunicator() {
  if (rendererConnection)
    return rendererConnection;

  const readiness = await extensionApi.runtime.sendMessage({
    type: "tex-for-gmail:ensure-renderer"
  });
  if (readiness?.ok !== true)
    throw new Error(readiness?.error || "The renderer could not be initialized.");

  const port = extensionApi.runtime.connect({ name: RENDER_PORT_NAME });
  const connection = {
    communicator: new Communicator(new PortWrapper(port)),
    disconnected: false,
    port
  };
  rendererConnection = connection;
  port.onDisconnect.addListener(() => {
    connection.disconnected = true;
    if (rendererConnection === connection)
      rendererConnection = undefined;
  });
  return connection;
}

function closeCommunicator(connection) {
  if (rendererConnection === connection)
    rendererConnection = undefined;
  if (!connection.disconnected) {
    connection.disconnected = true;
    connection.port.disconnect();
  }
}

function rendererRestarted(error, connection) {
  return connection.disconnected ||
    error?.err === RENDERER_RESTARTING_ERROR;
}

async function requestPngDataUrl(connection, source, display, scale, alpha) {
  const response = await connection.communicator.request(
    "compile2pngDataURL",
    {
      source,
      display,
      scale,
      alpha
    }
  );
  return requirePngDataUrl(response.dataUrl);
}

async function compileWithRendererSession(session, source, display, scale, alpha) {
  let mayRetry = true;
  while (true) {
    const connection = session.connection || await getCommunicator();
    session.connection = connection;
    try {
      return await requestPngDataUrl(connection, source, display, scale, alpha);
    } catch (error) {
      const retry = mayRetry && rendererRestarted(error, connection);
      if (session.connection === connection)
        session.connection = undefined;
      closeCommunicator(connection);
      if (!retry)
        throw error;
      mayRetry = false;
    }
  }
}

function closeRendererSession(session) {
  if (session.connection)
    closeCommunicator(session.connection);
  session.connection = undefined;
}

function requirePngDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" ||
      !dataUrl.startsWith(PNG_DATA_URL_PREFIX))
    throw new Error("Renderer returned an invalid PNG data URL.");

  const base64 = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (base64.length === 0 ||
      base64.length > MAX_PNG_BASE64_LENGTH ||
      base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
    throw new Error("Renderer returned an invalid PNG data URL.");

  const padding = base64.endsWith("==") ? 2 :
    base64.endsWith("=") ? 1 : 0;
  const decodedLength = (base64.length / 4) * 3 - padding;
  if (decodedLength < 8 || decodedLength > MAX_PNG_BYTES)
    throw new Error("PNG output exceeds the size limit or is empty.");

  let header;
  try {
    header = atob(base64.slice(0, 12));
  } catch {
    throw new Error("Renderer returned an invalid PNG data URL.");
  }
  if (header.length < 8 ||
      header.charCodeAt(0) !== 0x89 ||
      header.charCodeAt(1) !== 0x50 ||
      header.charCodeAt(2) !== 0x4e ||
      header.charCodeAt(3) !== 0x47 ||
      header.charCodeAt(4) !== 0x0d ||
      header.charCodeAt(5) !== 0x0a ||
      header.charCodeAt(6) !== 0x1a ||
      header.charCodeAt(7) !== 0x0a)
    throw new Error("PNG output has an invalid signature.");

  return dataUrl;
}

function editableForRange(range) {
  if (!range)
    return undefined;

  const container = range.commonAncestorContainer;
  const element = container.nodeType === Node.ELEMENT_NODE
    ? container
    : container.parentElement;
  return element?.closest?.(GMAIL_EDITOR_SELECTOR);
}

function showStatus(message, state = "progress") {
  let status = document.querySelector("#tex-for-gmail-status");
  if (!status) {
    status = document.createElement("div");
    status.id = "tex-for-gmail-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    document.documentElement.append(status);
  }

  clearTimeout(statusTimer);
  status.dataset.state = state;
  status.textContent = message;
  if (state !== "progress") {
    statusTimer = setTimeout(() => {
      status.remove();
    }, state === "error" ? 6000 : 2500);
  }
}

function rememberRenderedSource(token, source) {
  while (renderedSourcesByToken.size >= MAX_REMEMBERED_RENDERED_SOURCES) {
    const oldest = renderedSourcesByToken.keys().next().value;
    renderedSourcesByToken.delete(oldest);
  }
  renderedSourcesByToken.set(token, source);
}

function newRenderedSourceToken() {
  let token;
  do {
    token = crypto.randomUUID();
  } while (renderedSourcesByToken.has(token));
  return token;
}

function validRenderedSource(source) {
  return typeof source === "string" &&
    source.length > 0 &&
    source.length <= TeXForGmail.MAX_SOURCE_LENGTH;
}

function markRenderedImage(image, original) {
  if (!validRenderedSource(original))
    throw new Error("The formula source is invalid or exceeds the size limit.");

  const token = newRenderedSourceToken();
  renderedSources.set(image, original);
  rememberRenderedSource(token, original);
  image.dataset.texForGmailRendered = "1";
  image.dataset.texForGmailSourceToken = token;
  image.dataset.texForGmailVersion = "1";
}

function loadImage(dataUrl, original, display = false) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.alt = "Rendered math expression";
    image.className = display
      ? "tex-for-gmail-image tex-for-gmail-display"
      : "tex-for-gmail-image";
    image.contentEditable = "false";
    image.title = "Backspace, Delete, or double-click to edit";
    markRenderedImage(image, original);
    image.addEventListener("load", () => {
      if (image.naturalWidth < 1 ||
          image.naturalHeight < 1 ||
          image.naturalWidth > MAX_IMAGE_DIMENSION ||
          image.naturalHeight > MAX_IMAGE_DIMENSION ||
          image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS) {
        reject(new Error("The rendered image dimensions exceed the safety limit."));
        return;
      }
      image.width = Math.max(1, Math.round(image.naturalWidth / RENDER_SCALE));
      image.height = Math.max(1, Math.round(image.naturalHeight / RENDER_SCALE));
      resolve(image);
    }, { once: true });
    image.addEventListener("error", () => {
      reject(new Error("The rendered image could not be loaded."));
    }, { once: true });
    image.src = dataUrl;
  });
}

function notifyEditorInput(editor, inputType) {
  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType
  }));
}

function isRenderedMathImage(node) {
  return node?.nodeType === Node.ELEMENT_NODE &&
    node.matches?.(RENDERED_IMAGE_SELECTOR) === true;
}

function sourceForRenderedImage(image) {
  let source = renderedSources.get(image);
  if (validRenderedSource(source))
    return source;

  const token = image?.dataset?.texForGmailSourceToken;
  if (typeof token !== "string" ||
      !RENDERED_SOURCE_TOKEN_PATTERN.test(token))
    return undefined;
  source = renderedSourcesByToken.get(token);
  if (!validRenderedSource(source))
    return undefined;

  renderedSources.set(image, source);
  renderedSourcesByToken.delete(token);
  renderedSourcesByToken.set(token, source);
  return source;
}

function logicalMathStreams(editor) {
  const streams = [];
  let stream = { segments: [], text: "" };

  function finishStream() {
    if (stream.text)
      streams.push(stream);
    stream = { segments: [], text: "" };
  }

  function appendText(node) {
    if (!node.data)
      return;
    const start = stream.text.length;
    stream.text += node.data;
    stream.segments.push({
      end: stream.text.length,
      node,
      start
    });
  }

  function appendStructuralLineBreak() {
    if (stream.text && !stream.text.endsWith("\n"))
      stream.text += "\n";
  }

  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE)
      return;

    if (node.matches?.(MATH_EXCLUDED_SELECTOR)) {
      finishStream();
      return;
    }
    if (node.tagName === "BR") {
      stream.text += "\n";
      return;
    }
    if (node !== editor && MATH_STREAM_BARRIER_TAGS.has(node.tagName)) {
      finishStream();
      return;
    }

    const breaksLine = node !== editor &&
      MATH_LINE_BREAK_TAGS.has(node.tagName);
    if (breaksLine)
      appendStructuralLineBreak();
    for (const child of node.childNodes)
      visit(child);
    if (breaksLine)
      appendStructuralLineBreak();
  }

  visit(editor);
  finishStream();
  return streams;
}

function expressionBoundary(stream, index, end) {
  const character = end ? index - 1 : index;
  const segment = stream.segments.find(candidate =>
    candidate.start <= character && character < candidate.end
  );
  if (!segment)
    return undefined;
  return {
    node: segment.node,
    offset: index - segment.start
  };
}

function delimitedMathInEditor(editor) {
  const expressions = [];
  for (const stream of logicalMathStreams(editor)) {
    const matches = TeXForGmail.findDelimitedMath(stream.text);
    for (const match of matches) {
      if (expressions.length === MAX_BATCH_EXPRESSIONS)
        return { expressions, truncated: true };
      const start = expressionBoundary(stream, match.start, false);
      const end = expressionBoundary(stream, match.end, true);
      if (!start || !end)
        continue;
      expressions.push({
        ...match,
        endNode: end.node,
        endOffset: end.offset,
        startNode: start.node,
        startOffset: start.offset
      });
    }
  }
  return { expressions, truncated: false };
}

function pendingMathExpression(expression, editor) {
  if (!expression.startNode.isConnected ||
      !expression.endNode.isConnected ||
      !editor.contains(expression.startNode) ||
      !editor.contains(expression.endNode))
    return undefined;

  const pending = document.createElement("span");
  pending.dataset.texForGmailPending = "1";
  pending.textContent = expression.text;
  const range = document.createRange();
  range.setStart(expression.startNode, expression.startOffset);
  range.setEnd(expression.endNode, expression.endOffset);
  range.deleteContents();
  range.insertNode(pending);
  return pending;
}

async function renderAllMathInEditor(editor) {
  if (renderInProgress)
    return { ok: false, error: "A LaTeX render is already in progress." };

  const { expressions, truncated } = delimitedMathInEditor(editor);
  if (expressions.length === 0) {
    showStatus("No delimited math found.", "error");
    return { ok: true, rendered: 0 };
  }

  renderInProgress = true;
  const session = {};
  let failures = 0;
  let rendered = 0;
  try {
    showStatus("Rendering math…");
    const pendingExpressions = [];
    for (let index = expressions.length - 1; index >= 0; index--) {
      const expression = expressions[index];
      const pending = pendingMathExpression(expression, editor);
      if (pending)
        pendingExpressions.unshift({ expression, pending });
    }

    for (const { expression, pending } of pendingExpressions) {
      try {
        const normalized = TeXForGmail.normalizeInput(expression.text);
        const dataUrl = await compileWithRendererSession(
          session,
          normalized.source,
          normalized.display,
          RENDER_SCALE,
          1
        );
        const image = await loadImage(
          dataUrl,
          normalized.original,
          normalized.display
        );
        if (!pending.isConnected ||
            !editor.contains(pending) ||
            pending.textContent !== expression.text) {
          pending.removeAttribute("data-tex-for-gmail-pending");
          continue;
        }
        pending.replaceWith(image);
        rendered++;
      } catch (error) {
        failures++;
        if (pending.isConnected &&
            editor.contains(pending) &&
            pending.textContent === expression.text)
          pending.replaceWith(document.createTextNode(expression.text));
        else
          pending.removeAttribute("data-tex-for-gmail-pending");
      }
    }
    if (rendered)
      notifyEditorInput(editor, "insertReplacementText");
    if (failures || truncated) {
      const details = [];
      if (failures)
        details.push(`${failures} left as text`);
      if (truncated)
        details.push("Batch limit reached; click ∑ again for the rest");
      showStatus(
        `${rendered} expression${rendered === 1 ? "" : "s"} rendered. ` +
        `${details.join(". ")}.`,
        "error"
      );
      return { ok: false, rendered };
    }
    showStatus(
      `${rendered} expression${rendered === 1 ? "" : "s"} rendered.`,
      "success"
    );
    return { ok: true, rendered };
  } finally {
    closeRendererSession(session);
    renderInProgress = false;
  }
}

function edgeNode(node, backwards) {
  let current = node;
  while (current?.nodeType === Node.ELEMENT_NODE && current.childNodes.length) {
    current = current.childNodes[backwards
      ? current.childNodes.length - 1
      : 0];
  }
  return current;
}

function siblingAtRangeBoundary(node, backwards, editor) {
  for (let current = node; current && current !== editor;
    current = current.parentNode) {
    const sibling = backwards ? current.previousSibling : current.nextSibling;
    if (sibling)
      return edgeNode(sibling, backwards);
  }
  return undefined;
}

function imageAtDeletionBoundary(range, backwards, editor) {
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.ELEMENT_NODE) {
    const node = startContainer.childNodes[backwards
      ? startOffset - 1
      : startOffset];
    return isRenderedMathImage(edgeNode(node, backwards))
      ? edgeNode(node, backwards)
      : undefined;
  }
  if (startContainer.nodeType !== Node.TEXT_NODE ||
      (backwards && startOffset !== 0) ||
      (!backwards && startOffset !== startContainer.data.length))
    return undefined;

  const node = siblingAtRangeBoundary(startContainer, backwards, editor);
  return isRenderedMathImage(node) ? node : undefined;
}

function selectedMathImage(range) {
  if (range.collapsed ||
      range.startContainer !== range.endContainer ||
      range.startContainer.nodeType !== Node.ELEMENT_NODE ||
      range.endOffset !== range.startOffset + 1)
    return undefined;
  const node = range.startContainer.childNodes[range.startOffset];
  return isRenderedMathImage(node) ? node : undefined;
}

function restoreRenderedImage(image, caretAtStart = false) {
  const source = sourceForRenderedImage(image);
  if (!source)
    return false;

  const editor = image.closest?.(GMAIL_EDITOR_SELECTOR);
  if (!editor)
    return false;
  const selection = window.getSelection();
  const selectionRange = document.createRange();
  selectionRange.selectNode(image);
  selection?.removeAllRanges();
  selection?.addRange(selectionRange);
  try {
    if (document.execCommand("insertText", false, source) && !image.isConnected) {
      if (caretAtStart) {
        const range = selection?.rangeCount
          ? selection.getRangeAt(0)
          : undefined;
        const text = range?.startContainer;
        const start = range?.startOffset - source.length;
        if (range?.collapsed && text?.nodeType === Node.TEXT_NODE &&
            start >= 0 &&
            text.data.slice(start, range.startOffset) === source) {
          range.setStart(text, start);
          range.collapse(true);
        }
      }
      return true;
    }
  } catch {}

  const text = document.createTextNode(source);
  image.replaceWith(text);
  const range = document.createRange();
  range.setStart(text, caretAtStart ? 0 : source.length);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  notifyEditorInput(editor, "insertReplacementText");
  return true;
}

function handleEditorBeforeInput(editor, event) {
  const backwards = event.inputType === "deleteContentBackward";
  const forwards = event.inputType === "deleteContentForward";
  if (!backwards && !forwards)
    return;

  const selection = window.getSelection();
  if (!selection?.rangeCount)
    return;
  const range = selection.getRangeAt(0);
  if (editableForRange(range) !== editor)
    return;

  const image = selectedMathImage(range) ||
    (range.collapsed && imageAtDeletionBoundary(range, backwards, editor));
  if (image && restoreRenderedImage(image, forwards))
    event.preventDefault();
}

function handleEditorDoubleClick(event) {
  const image = isRenderedMathImage(event.target)
    ? event.target
    : event.target?.closest?.(RENDERED_IMAGE_SELECTOR);
  if (image && restoreRenderedImage(image))
    event.preventDefault();
}

function configureGmailEditor(editor) {
  if (configuredEditors.has(editor))
    return;
  configuredEditors.add(editor);
  editor.addEventListener(
    "beforeinput",
    event => handleEditorBeforeInput(editor, event),
    true
  );
  editor.addEventListener("dblclick", handleEditorDoubleClick);
}

function formattingAnchor(editor) {
  let match;
  for (const anchor of document.querySelectorAll(GMAIL_BOLD_SELECTOR)) {
    const toolbar = anchor.closest?.('[role="toolbar"]');
    if (!toolbar)
      continue;

    for (let scope = editor.parentElement; scope; scope = scope.parentElement) {
      if (!scope.contains?.(toolbar))
        continue;
      const editors = scope.querySelectorAll?.(GMAIL_EDITOR_SELECTOR);
      if (!editors || editors.length !== 1 || editors[0] !== editor)
        break;
      if (match)
        return undefined;
      match = anchor;
      break;
    }
  }
  return match;
}

function installGmailToolbarButton(editor) {
  const anchor = formattingAnchor(editor);
  const parent = anchor?.parentElement;
  if (!parent || parent.querySelector(TOOLBAR_BUTTON_SELECTOR))
    return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "tex-for-gmail-toolbar-button";
  button.dataset.texForGmailToolbarButton = "1";
  button.setAttribute("aria-label", "Render math");
  button.setAttribute("title", "Render delimited math");
  button.textContent = "∑";
  button.addEventListener("mousedown", event => event.preventDefault());
  button.addEventListener("click", () => {
    void renderAllMathInEditor(editor);
  });
  parent.insertBefore(button, anchor.nextSibling);
  configureGmailEditor(editor);
}

function syncGmailToolbars() {
  for (const editor of document.querySelectorAll(GMAIL_EDITOR_SELECTOR))
    installGmailToolbarButton(editor);
}

function scheduleToolbarSync() {
  if (toolbarRefreshQueued)
    return;
  toolbarRefreshQueued = true;
  queueMicrotask(() => {
    toolbarRefreshQueued = false;
    syncGmailToolbars();
  });
}

function startGmailToolbarIntegration() {
  if (!document.body || typeof document.querySelectorAll !== "function")
    return;
  syncGmailToolbars();
  if (typeof MutationObserver !== "function")
    return;

  new MutationObserver(scheduleToolbarSync).observe(document.body, {
    childList: true,
    subtree: true
  });
}

document.addEventListener("focusin", () => {
  scheduleToolbarSync();
});
startGmailToolbarIntegration();
