#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const repository = "https://github.com/TeX-for-Gmail/TeX-Live-Files.git";
const revision = "41bdfeea35d787cb2f314eea4d707bb32bc996ac";
const destination = path.join(
  root,
  "chrome-extension",
  "resources",
  "texlive"
);
const indexFile = path.join(
  root,
  "chrome-extension",
  "resources",
  "data",
  "index.json"
);

const directories = [
  "texlive/texmf-dist/fonts/tfm/public/amsfonts",
  "texlive/texmf-dist/fonts/tfm/public/cm",
  "texlive/texmf-dist/fonts/type1/public/amsfonts",
  "texlive/texmf-dist/tex/generic/ifxetex",
  "texlive/texmf-dist/tex/generic/luatex85",
  "texlive/texmf-dist/tex/generic/xkeyval",
  "texlive/texmf-dist/tex/latex/amsfonts",
  "texlive/texmf-dist/tex/latex/amsmath",
  "texlive/texmf-dist/tex/latex/preview",
  "texlive/texmf-dist/tex/latex/standalone",
  "texlive/texmf-dist/tex/latex/xkeyval"
];

const files = [
  "texlive/LICENSE.CTAN",
  "texlive/LICENSE.TL",
  "texlive/texmf.cnf",
  "texlive/texmf-config/ls-R",
  "texlive/texmf-dist/fonts/map/fontname/texfonts.map",
  "texlive/texmf-dist/ls-R",
  "texlive/texmf-dist/tex/generic/oberdiek/ifluatex.sty",
  "texlive/texmf-dist/tex/generic/oberdiek/ifpdf.sty",
  "texlive/texmf-dist/tex/latex/base/article.cls",
  "texlive/texmf-dist/tex/latex/base/size10.clo",
  "texlive/texmf-dist/tex/latex/tools/shellesc.sty",
  "texlive/texmf-dist/web2c/texmf.cnf",
  "texlive/texmf-var/fonts/map/pdftex/updmap/pdftex.map",
  "texlive/texmf-var/ls-R",
  "texlive/texmf-var/web2c/pdftex/pdflatex.fmt"
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function buildIndex(directory) {
  const index = {};
  let count = 0;

  function add(current, parts) {
    const [part, ...rest] = parts;
    if (rest.length === 0) {
      current[part] = null;
      return;
    }
    current[part] ||= {};
    add(current[part], rest);
  }

  function visit(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      );
    for (const entry of entries) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory())
        visit(filename);
      else if (entry.isFile()) {
        add(index, path.relative(directory, filename).split(path.sep));
        count += 1;
      }
    }
  }

  visit(directory);
  return { count, index };
}

function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tex-for-gmail-"));
  const checkout = path.join(temporaryRoot, "TeX-Live-Files");

  try {
    run("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      repository,
      checkout
    ]);
    run("git", [
      "-C",
      checkout,
      "sparse-checkout",
      "set",
      "--no-cone",
      ...directories.map(entry => `/${entry}/`),
      ...files.map(entry => `/${entry}`)
    ]);
    run("git", ["-C", checkout, "checkout", "--detach", revision]);
    const actualRevision = run("git", ["-C", checkout, "rev-parse", "HEAD"]);
    if (actualRevision !== revision)
      throw new Error(`Expected ${revision}, checked out ${actualRevision}`);

    fs.rmSync(destination, { force: true, recursive: true });
    fs.cpSync(path.join(checkout, "texlive"), destination, {
      recursive: true
    });
    const { count, index } = buildIndex(destination);
    fs.writeFileSync(indexFile, `${JSON.stringify(index)}\n`);

    console.log(`Vendored TeX Live ${revision}; files: ${count}.`);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

main();
