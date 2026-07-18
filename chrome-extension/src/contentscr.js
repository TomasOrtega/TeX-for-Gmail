"use strict";

const extensionApi = globalThis.browser || globalThis.chrome;
const RENDER_SCALE = 2;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const MAX_ALT_LENGTH = 512;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_PNG_BASE64_LENGTH = Math.ceil(MAX_PNG_BYTES / 3) * 4;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
let communicator;
let savedRange;
let statusTimer;
let renderInProgress = false;

async function getCommunicator() {
  if (communicator)
    return communicator;

  const readiness = await extensionApi.runtime.sendMessage({
    type: "tex-for-gmail:ensure-renderer"
  });
  if (readiness?.ok !== true)
    throw new Error(readiness?.error || "The renderer could not be initialized.");

  const port = extensionApi.runtime.connect({ name: random_id(64) });
  communicator = new Communicator(new PortWrapper(port));
  port.onDisconnect.addListener(() => {
    communicator = undefined;
  });
  return communicator;
}

async function compile2pngDataURL(srcCode, scale, alpha) {
  const comm = await getCommunicator();
  const response = await comm.request("compile2pngDataURL", {
    srcCode,
    scale,
    alpha
  });

  return requirePngDataUrl(response.dataUrl);
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
  return element?.closest?.('[contenteditable="true"]');
}

function rememberSelection() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0)
    return;

  const range = selection.getRangeAt(0);
  if (editableForRange(range))
    savedRange = range.cloneRange();
}

function insertionRange() {
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const current = selection.getRangeAt(0);
    if (editableForRange(current))
      return current.cloneRange();
  }

  if (savedRange?.commonAncestorContainer?.isConnected &&
      editableForRange(savedRange))
    return savedRange.cloneRange();

  throw new Error("Place the cursor in a Gmail message first.");
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

function messageForError(error) {
  if (typeof error === "string")
    return error;
  if (error?.err)
    return messageForError(error.err);
  if (error?.message)
    return error.message;
  return "LaTeX rendering failed.";
}

function loadImage(dataUrl, original) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.alt = original.length <= MAX_ALT_LENGTH
      ? original
      : "Rendered LaTeX formula";
    image.className = "tex-for-gmail-image";
    image.contentEditable = "false";
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

function insertImage(range, image) {
  const editor = editableForRange(range);
  if (!editor)
    throw new Error("Place the cursor in a Gmail message first.");

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  if (!document.execCommand("insertHTML", false, image.outerHTML)) {
    range.deleteContents();
    range.insertNode(image);
    range.setStartAfter(image);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertFromPaste"
  }));
  rememberSelection();
}

async function renderLatex({ latex, display } = {}) {
  if (renderInProgress)
    return { ok: false, error: "A LaTeX render is already in progress." };

  renderInProgress = true;
  let range;
  try {
    range = insertionRange();
    const selectedText = range.toString();
    const normalized = TeXForGmail.normalizeInput(
      latex ?? selectedText,
      typeof display === "boolean" ? display : undefined
    );
    const documentSource = TeXForGmail.buildDocument(normalized);

    showStatus("Rendering LaTeX…");
    const dataUrl = await compile2pngDataURL(
      documentSource,
      RENDER_SCALE,
      1
    );
    const image = await loadImage(dataUrl, normalized.original);
    insertImage(range, image);
    showStatus("LaTeX inserted.", "success");
    return { ok: true };
  } catch (error) {
    const message = messageForError(error);
    showStatus(message, "error");
    return { ok: false, error: message };
  } finally {
    renderInProgress = false;
  }
}

document.addEventListener("selectionchange", rememberSelection);
document.addEventListener("focusin", rememberSelection);

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "tex-for-gmail:render")
    return undefined;

  const malformed =
    (message.latex !== undefined && typeof message.latex !== "string") ||
    (message.display !== undefined && typeof message.display !== "boolean");
  const result = malformed
    ? Promise.resolve({
      ok: false,
      error: "Malformed LaTeX render request."
    })
    : renderLatex(message);
  result.then(
    sendResponse,
    error => sendResponse({ ok: false, error: messageForError(error) })
  );
  return true;
});
