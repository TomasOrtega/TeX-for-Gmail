"use strict";

const ENSURE_RENDERER_MESSAGE = "tex-for-gmail:ensure-renderer";
const RENDER_CONTEXT_MENU_ID = "tex-for-gmail-render";

function isGmailUrl(url) {
  return /^https:\/\/mail\.google\.com(?:\/|$)/.test(url || "");
}

function isGmailSender(sender) {
  return isGmailUrl(sender?.url || sender?.tab?.url);
}

function isGmailTab(tab) {
  return tab && typeof tab.id === "number" && isGmailUrl(tab.url);
}

function errorMessage(error) {
  return error?.message || String(error);
}

function handleRendererBootstrap(message, sender, sendResponse) {
  if (message?.type !== ENSURE_RENDERER_MESSAGE)
    return undefined;

  if (!isGmailSender(sender)) {
    sendResponse({
      error: "Renderer initialization is restricted to Gmail.",
      ok: false
    });
    return false;
  }

  const bootstrap = globalThis.texForGmailEnsureRenderer;
  Promise.resolve()
    .then(() => {
      if (typeof bootstrap === "function")
        return bootstrap();
      return undefined;
    })
    .then(
      () => sendResponse({ ok: true }),
      error => sendResponse({ error: errorMessage(error), ok: false })
    );
  return true;
}

function sendRenderRequest(tab, latex) {
  if (!isGmailTab(tab))
    return;

  const message = {
    type: "tex-for-gmail:render"
  };
  if (latex !== undefined)
    message.latex = latex;

  chrome.tabs.sendMessage(tab.id, message, function () {
    if (chrome.runtime.lastError)
      console.warn(chrome.runtime.lastError.message);
  });
}

function sendRenderRequestToActiveTab(latex) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (chrome.runtime.lastError) {
      console.warn(chrome.runtime.lastError.message);
      return;
    }

    const gmailTab = tabs.find(isGmailTab);
    if (gmailTab)
      sendRenderRequest(gmailTab, latex);
  });
}

function createRenderContextMenu() {
  chrome.contextMenus.remove(RENDER_CONTEXT_MENU_ID, function () {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: RENDER_CONTEXT_MENU_ID,
      title: "Render LaTeX",
      contexts: ["selection"],
      documentUrlPatterns: ["https://mail.google.com/*"]
    }, function () {
      if (chrome.runtime.lastError)
        console.warn(chrome.runtime.lastError.message);
    });
  });
}

chrome.runtime.onMessage.addListener(handleRendererBootstrap);

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(function (info, tab) {
    if (info.menuItemId === RENDER_CONTEXT_MENU_ID &&
        typeof info.selectionText === "string" &&
        info.selectionText.trim())
      sendRenderRequest(tab, info.selectionText);
  });
  if (chrome.runtime.onInstalled)
    chrome.runtime.onInstalled.addListener(createRenderContextMenu);
  if (chrome.runtime.getManifest().manifest_version === 2)
    createRenderContextMenu();
}

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(function (command) {
    if (command === "render-selection")
      sendRenderRequestToActiveTab();
  });
}
