"use strict";

const ENSURE_RENDERER_MESSAGE = "tex-for-gmail:ensure-renderer";

function isGmailUrl(url) {
  return /^https:\/\/mail\.google\.com(?:\/|$)/.test(url || "");
}

function isGmailSender(sender) {
  return isGmailUrl(sender?.url || sender?.tab?.url);
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

chrome.runtime.onMessage.addListener(handleRendererBootstrap);
