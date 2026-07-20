"use strict";

const CHROME_OFFSCREEN_PATH = "src/chrome-offscreen.html";
const OFFSCREEN_IDLE_CLOSE_MESSAGE =
  "tex-for-gmail:close-idle-renderer";
const OFFSCREEN_PREPARE_CLOSE_MESSAGE =
  "tex-for-gmail:prepare-idle-renderer-close";
const OFFSCREEN_CANCEL_CLOSE_MESSAGE =
  "tex-for-gmail:cancel-idle-renderer-close";
let ensuringOffscreenDocument;
let offscreenOperation = Promise.resolve();

function serializeOffscreenOperation(operation) {
  const result = offscreenOperation.then(operation, operation);
  offscreenOperation = result.catch(() => undefined);
  return result;
}

async function createOffscreenRendererIfNeeded() {
  const documentUrl = chrome.runtime.getURL(CHROME_OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });
  if (contexts.length > 0)
    return;

  await chrome.offscreen.createDocument({
    url: CHROME_OFFSCREEN_PATH,
    reasons: ["BLOBS"],
    justification: "Render local MathJax SVG output into a PNG image."
  });
}

function ensureOffscreenRenderer() {
  if (!ensuringOffscreenDocument) {
    ensuringOffscreenDocument = serializeOffscreenOperation(
      createOffscreenRendererIfNeeded
    ).finally(() => {
      ensuringOffscreenDocument = undefined;
    });
  }
  return ensuringOffscreenDocument;
}

async function closeIdleOffscreenRenderer(generation) {
  const preparation = await chrome.runtime.sendMessage({
    generation,
    type: OFFSCREEN_PREPARE_CLOSE_MESSAGE
  });
  if (preparation?.ok !== true)
    return false;

  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    try {
      await chrome.runtime.sendMessage({
        generation,
        type: OFFSCREEN_CANCEL_CLOSE_MESSAGE
      });
    } catch (cancelError) {
      console.warn(cancelError.message);
    }
    throw error;
  }
  return true;
}

globalThis.texForGmailEnsureRenderer = ensureOffscreenRenderer;
importScripts("controller.js");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== OFFSCREEN_IDLE_CLOSE_MESSAGE ||
      sender?.id !== chrome.runtime.id ||
      sender?.url !== chrome.runtime.getURL(CHROME_OFFSCREEN_PATH))
    return undefined;

  if (!Number.isSafeInteger(message.generation) ||
      message.generation < 0) {
    sendResponse({ ok: false });
    return false;
  }

  serializeOffscreenOperation(
    () => closeIdleOffscreenRenderer(message.generation)
  ).then(
    closed => sendResponse({ ok: closed }),
    error => {
      console.warn(error.message);
      sendResponse({ error: error.message, ok: false });
    }
  );
  return true;
});
