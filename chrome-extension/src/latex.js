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

  function isEscaped(value, index) {
    let slashCount = 0;
    for (let offset = index - 1;
      offset >= 0 && value[offset] === "\\";
      offset--)
      slashCount++;
    return slashCount % 2 === 1;
  }

  function closingDelimiter(value, start, delimiter, singleDollar) {
    for (let index = start;
      index <= value.length - delimiter.length;
      index++) {
      if (!value.startsWith(delimiter, index) || isEscaped(value, index))
        continue;
      if (singleDollar &&
          (value[index - 1] === "$" || value[index + 1] === "$"))
        continue;
      return index + delimiter.length;
    }
    return -1;
  }

  function findDelimitedMath(value) {
    const input = String(value ?? "");
    const expressions = [];

    for (let start = 0; start < input.length; start++) {
      let delimiter;
      let singleDollar = false;
      if (input.startsWith("$$", start) && !isEscaped(input, start))
        delimiter = "$$";
      else if (input.startsWith("\\[", start) && !isEscaped(input, start))
        delimiter = "\\[";
      else if (input.startsWith("\\(", start) && !isEscaped(input, start))
        delimiter = "\\(";
      else if (input[start] === "$" &&
               !isEscaped(input, start) &&
               input[start - 1] !== "$" &&
               input[start + 1] !== "$") {
        delimiter = "$";
        singleDollar = true;
      } else {
        continue;
      }

      const closing = delimiter === "\\[" ? "\\]" :
        delimiter === "\\(" ? "\\)" : delimiter;
      const end = closingDelimiter(
        input,
        start + delimiter.length,
        closing,
        singleDollar
      );
      if (end < 0)
        continue;

      if (singleDollar &&
          (/\s/.test(input[start + 1]) ||
           /\s/.test(input[end - 2]) ||
           /[\r\n]/.test(input.slice(start + 1, end - 1)))) {
        start = end - 1;
        continue;
      }
      const text = input.slice(start, end);
      try {
        normalizeInput(text);
      } catch {
        start = end - 1;
        continue;
      }
      expressions.push({ end, start, text });
      start = end - 1;
    }
    return expressions;
  }

  return {
    findDelimitedMath,
    MAX_SOURCE_LENGTH,
    normalizeInput
  };
});
