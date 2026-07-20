"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const sourceDirectory = "chrome-extension/src";

function discoverRuntimeSources(rootDirectory = root) {
  function discover(directory) {
    return fs.readdirSync(path.join(rootDirectory, directory), {
      withFileTypes: true
    }).flatMap(entry => {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory())
        return discover(relative);
      return entry.isFile() && entry.name.endsWith(".js") ? [relative] : [];
    });
  }

  return discover(sourceDirectory).sort();
}

module.exports = { discoverRuntimeSources };
