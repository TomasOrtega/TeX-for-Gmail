"use strict";

(function (root, factory) {
  const api = factory();

  root.TeXForGmail = api;
  if (typeof module === "object" && module.exports)
    module.exports = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  const MAX_SOURCE_LENGTH = 20000;

  function normalizeInput(value, displayOverride) {
    const original = String(value ?? "").trim();
    if (!original)
      throw new Error("Enter some LaTeX first.");
    if (original.length > MAX_SOURCE_LENGTH)
      throw new Error("LaTeX input is too long.");

    let source = original;
    let display = false;

    if (source.startsWith("$$") && source.endsWith("$$") && source.length > 4) {
      source = source.slice(2, -2).trim();
      display = true;
    } else if (source.startsWith("\\[") && source.endsWith("\\]") && source.length > 4) {
      source = source.slice(2, -2).trim();
      display = true;
    } else if (source.startsWith("\\(") && source.endsWith("\\)") && source.length > 4) {
      source = source.slice(2, -2).trim();
    } else if (source.startsWith("$") && source.endsWith("$") && source.length > 2) {
      source = source.slice(1, -1).trim();
    }

    if (!source)
      throw new Error("Enter some LaTeX first.");
    if (typeof displayOverride === "boolean")
      display = displayOverride;

    return { source, display, original };
  }

  function buildDocument({ source, display }) {
    const math = display ? `\\[${source}\\]` : `\\(${source}\\)`;

    return [
      "\\documentclass[preview,border=2pt]{standalone}",
      "\\usepackage{amsmath,amssymb}",
      "\\begin{document}",
      math,
      "\\end{document}"
    ].join("\n");
  }

  return {
    MAX_SOURCE_LENGTH,
    normalizeInput,
    buildDocument
  };
});
