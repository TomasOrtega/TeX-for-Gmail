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

  function indexDelimiters(value) {
    const escaped = new Uint8Array(value.length);
    const positions = {
      "$": [],
      "$$": [],
      "\\)": [],
      "\\]": []
    };
    let slashParity = 0;

    for (let index = 0; index < value.length; index++) {
      escaped[index] = slashParity;
      if (!slashParity && value[index] === "$") {
        if (value[index + 1] === "$")
          positions["$$"].push(index);
        else if (value[index - 1] !== "$")
          positions["$"].push(index);
      } else if (!slashParity && value[index] === "\\") {
        if (value[index + 1] === ")")
          positions["\\)"].push(index);
        else if (value[index + 1] === "]")
          positions["\\]"].push(index);
      }
      slashParity = value[index] === "\\" ? 1 - slashParity : 0;
    }

    return {
      cursors: {
        "$": 0,
        "$$": 0,
        "\\)": 0,
        "\\]": 0
      },
      escaped,
      positions
    };
  }

  function closingDelimiter(delimiters, start, delimiter) {
    const positions = delimiters.positions[delimiter];
    let cursor = delimiters.cursors[delimiter];

    while (cursor < positions.length && positions[cursor] < start)
      cursor++;
    delimiters.cursors[delimiter] = cursor;
    return cursor < positions.length ?
      positions[cursor] + delimiter.length :
      -1;
  }

  function delimiterEscaped(value, index) {
    let slashParity = 0;
    for (let cursor = index - 1;
      cursor >= 0 && value[cursor] === "\\";
      cursor--)
      slashParity = 1 - slashParity;
    return Boolean(slashParity);
  }

  function boundedClosingDelimiter(value, start, delimiter, exhausted) {
    if (exhausted.has(delimiter))
      return -1;

    for (let index = value.indexOf(delimiter, start);
      index >= 0;
      index = value.indexOf(delimiter, index + 1)) {
      if (delimiterEscaped(value, index))
        continue;
      if (delimiter === "$" &&
          (value[index - 1] === "$" || value[index + 1] === "$"))
        continue;
      return index + delimiter.length;
    }
    exhausted.add(delimiter);
    return -1;
  }

  function findDelimitedMath(value, resultLimit = Infinity) {
    const input = String(value ?? "");
    if (resultLimit !== Infinity &&
        (!Number.isSafeInteger(resultLimit) || resultLimit < 0))
      throw new RangeError("Result limit must be a non-negative integer.");

    const expressions = [];
    if (resultLimit === 0)
      return expressions;
    const bounded = resultLimit !== Infinity;
    const delimiters = bounded ? undefined : indexDelimiters(input);
    const exhausted = bounded ? new Set() : undefined;
    const escaped = index => bounded
      ? delimiterEscaped(input, index)
      : Boolean(delimiters.escaped[index]);

    for (let start = 0; start < input.length; start++) {
      let delimiter;
      let singleDollar = false;
      if (input.startsWith("$$", start) && !escaped(start))
        delimiter = "$$";
      else if (input.startsWith("\\[", start) && !escaped(start))
        delimiter = "\\[";
      else if (input.startsWith("\\(", start) && !escaped(start))
        delimiter = "\\(";
      else if (input[start] === "$" &&
               !escaped(start) &&
               input[start - 1] !== "$" &&
               input[start + 1] !== "$") {
        delimiter = "$";
        singleDollar = true;
      } else {
        continue;
      }

      const closing = delimiter === "\\[" ? "\\]" :
        delimiter === "\\(" ? "\\)" : delimiter;
      const end = bounded
        ? boundedClosingDelimiter(
          input,
          start + delimiter.length,
          closing,
          exhausted
        )
        : closingDelimiter(
          delimiters,
          start + delimiter.length,
          closing
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
      if (expressions.length === resultLimit)
        return expressions;
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
