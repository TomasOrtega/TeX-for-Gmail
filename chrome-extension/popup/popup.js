"use strict";

const extensionApi = globalThis.browser || globalThis.chrome;
const form = document.querySelector("#latex-form");
const input = document.querySelector("#latex");
const display = document.querySelector("#display");
const status = document.querySelector("#status");
const submit = form.querySelector("button");

function errorMessage(error) {
  return error?.message || error?.err || String(error);
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  submit.disabled = true;
  status.textContent = "Rendering…";

  try {
    const [tab] = await extensionApi.tabs.query({
      active: true,
      currentWindow: true
    });
    if (typeof tab?.id !== "number" ||
        !tab.url?.startsWith("https://mail.google.com/"))
      throw new Error("Open a Gmail draft before inserting LaTeX.");

    const message = {
      type: "tex-for-gmail:render",
      latex: input.value
    };
    if (display.checked)
      message.display = true;

    const result = await extensionApi.tabs.sendMessage(tab.id, message);
    if (result?.ok === false)
      throw new Error(result.error);

    window.close();
  } catch (error) {
    status.textContent = errorMessage(error);
    submit.disabled = false;
  }
});
