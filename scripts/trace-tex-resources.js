#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const originalFetch = globalThis.fetch;
const localMode = process.argv.includes("--local");

globalThis.XMLHttpRequest = class {
  open(method, url, asynchronous = true) {
    this.method = method;
    this.url = url;
    this.asynchronous = asynchronous;
  }

  send() {
    if (this.asynchronous) {
      originalFetch(this.url)
        .then(async response => {
          this.status = response.status;
          this.response = await response.arrayBuffer();
          this.readyState = 4;
          this.onreadystatechange?.();
          this.onload?.();
        })
        .catch(error => this.onerror?.(error));
      return;
    }

    const response = spawnSync("curl", ["--fail", "--silent", "--show-error", this.url], {
      encoding: null,
      maxBuffer: 32 * 1024 * 1024
    });
    this.status = response.status === 0 ? 200 : 500;
    if (response.status !== 0)
      throw new Error(response.stderr.toString("utf8"));
    const bytes = response.stdout;
    this.response = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );
    this.responseText = bytes.toString("latin1");
    this.readyState = 4;
    this.onreadystatechange?.();
  }

  getResponseHeader(name) {
    if (name.toLowerCase() === "content-length")
      return String(this.response?.byteLength ?? 0);
    return null;
  }

  setRequestHeader() {}

  overrideMimeType() {}
};

const BrowserFS = require(path.join(
  root,
  "chrome-extension",
  "resources",
  "scripts",
  "browserfs.min.js"
));
const pdflatex = require(path.join(
  root,
  "chrome-extension",
  "resources",
  "scripts",
  "pdflatex.js"
));
const index = require(path.join(
  root,
  "chrome-extension",
  "resources",
  "data",
  "index.json"
));

const revision = "41bdfeea35d787cb2f314eea4d707bb32bc996ac";
const baseUrl = localMode
  ? pathToFileURL(path.join(
    root,
    "chrome-extension",
    "resources",
    "texlive",
    path.sep
  )).href
  : `https://cdn.jsdelivr.net/gh/TeX-for-Gmail/TeX-Live-Files@${revision}/texlive`;
const wasmPath = path.join(
  root,
  "chrome-extension",
  "resources",
  "wasm",
  "pdflatex.wasm"
);

globalThis.self = globalThis;
globalThis.importScripts = function () {};
globalThis.location = {
  href: pathToFileURL(path.join(
    root,
    "chrome-extension",
    "resources",
    "scripts",
    "pdflatex.js"
  )).href
};
globalThis.BrowserFS = BrowserFS;
globalThis.fetch = function (input, init) {
  if (String(input) === "../resources/wasm/pdflatex.wasm")
    return Promise.resolve(new Response(fs.readFileSync(wasmPath)));
  return originalFetch(input, init);
};

function configureBrowserFs() {
  return new Promise((resolve, reject) => {
    const texLive = localMode
      ? {
          fs: "XmlHttpRequest",
          options: {
            baseUrl,
            index,
            preferXHR: true
          }
        }
      : {
          fs: "CacheFS",
          options: {
            fast: { fs: "InMemory" },
            slow: {
              fs: "XmlHttpRequest",
              options: {
                baseUrl,
                index,
                preferXHR: true
              }
            }
          }
        };
    BrowserFS.configure({
      fs: "MountableFileSystem",
      options: {
        "/texlive": texLive,
        "/formats": { fs: "InMemory" }
      }
    }, error => error ? reject(error) : resolve());
  });
}

function loadModule() {
  return new Promise((resolve, reject) => {
    try {
      pdflatex({
        onAbort(reason) {
          reject(new Error(String(reason)));
        },
        print() {},
        printErr() {}
      }).then2(resolve);
    } catch (error) {
      reject(error);
    }
  });
}

function walk(fileSystem, directory, result = []) {
  for (const entry of fileSystem.readdirSync(directory)) {
    const filename = path.posix.join(directory, entry);
    const stat = fileSystem.statSync(filename);
    if (stat.isDirectory())
      walk(fileSystem, filename, result);
    else
      result.push(filename);
  }
  return result;
}

async function main() {
  await configureBrowserFs();
  const module = await loadModule();
  const source = fs.readFileSync(
    path.join(root, "test", "fixtures", "render-smoke.tex"),
    "utf8"
  );
  module.FS.writeFile("source.tex", source);
  module.callMain([
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-no-shell-escape",
    "source.tex"
  ]);
  const pdf = module.FS.readFile("source.pdf");
  if (localMode) {
    console.log(JSON.stringify({
      mode: "packaged",
      pdfBytes: pdf.byteLength
    }, null, 2));
    return;
  }
  const mounted = BrowserFS.BFSRequire("fs")
    .getRootFS()
    .mntMap["/texlive"]
    ._fast;
  const files = walk(mounted, "/").sort();
  console.log(JSON.stringify({ files, pdfBytes: pdf.byteLength }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
