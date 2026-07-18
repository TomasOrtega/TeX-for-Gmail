"use strict";

const CHROME_OFFSCREEN_PATH = "src/chrome-offscreen.html";
let creatingOffscreenDocument;

async function ensureOffscreenRenderer() {
  const documentUrl = chrome.runtime.getURL(CHROME_OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });
  if (contexts.length > 0)
    return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: CHROME_OFFSCREEN_PATH,
      reasons: ["WORKERS"],
      justification: "Run the packaged pdfTeX and MuPDF workers locally."
    }).finally(() => {
      creatingOffscreenDocument = undefined;
    });
  }
  await creatingOffscreenDocument;
}

globalThis.texForGmailEnsureRenderer = ensureOffscreenRenderer;
importScripts("controller.js");
