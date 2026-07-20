#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LOCK_FILE = "artifacts.lock.json";

function fail(message) {
  throw new Error(message);
}

function safePath(root, relativePath) {
  if (typeof relativePath !== "string" ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).includes(".."))
    fail(`Unsafe artifact path: ${relativePath}`);

  return path.join(root, relativePath);
}

function sha256(filename) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filename))
    .digest("hex");
}

function walk(directory) {
  if (!fs.existsSync(directory))
    return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(filename) : [filename];
  });
}

function discoverProtectedArtifacts(root) {
  const mathJaxResources = path.join(
    root,
    "chrome-extension",
    "resources",
    "mathjax"
  );
  return walk(mathJaxResources)
    .map(filename => path.relative(root, filename).split(path.sep).join("/"));
}

function requireText(value, location) {
  if (typeof value !== "string" || value.trim() === "")
    fail(`${location} must be a non-empty string`);
}

function verifyArtifacts({
  root = path.join(__dirname, ".."),
  quiet = false
} = {}) {
  const lockPath = path.join(root, LOCK_FILE);
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const packageLock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8")
  );

  if (lock.schemaVersion !== 1)
    fail(`Unsupported ${LOCK_FILE} schema: ${lock.schemaVersion}`);

  for (const [name, remote] of Object.entries(lock.remoteResources || {})) {
    requireText(remote.repository, `remoteResources.${name}.repository`);
    if (!/^[0-9a-f]{40}$/.test(remote.commit || ""))
      fail(`remoteResources.${name}.commit must be a full Git commit`);
    if (!remote.baseUrl.includes(`@${remote.commit}/`))
      fail(`remoteResources.${name}.baseUrl is not pinned to its commit`);
  }

  for (const [name, source] of Object.entries(lock.sourceResources || {})) {
    requireText(source.repository, `sourceResources.${name}.repository`);
    if (!/^[0-9a-f]{40}$/.test(source.commit || ""))
      fail(`sourceResources.${name}.commit must be a full Git commit`);
    requireText(source.vendorScript, `sourceResources.${name}.vendorScript`);
    const vendorScript = safePath(root, source.vendorScript);
    if (!fs.existsSync(vendorScript))
      fail(`Missing vendor script: ${source.vendorScript}`);
    if (!fs.readFileSync(vendorScript, "utf8").includes(source.commit))
      fail(`${source.vendorScript} does not pin ${source.commit}`);
  }

  const listed = new Set();
  let verified = 0;
  for (const [componentIndex, component] of (lock.components || []).entries()) {
    const location = `components[${componentIndex}]`;
    for (const field of ["component", "version", "license", "source", "provenance"])
      requireText(component[field], `${location}.${field}`);
    if (component.sourceRevision !== undefined &&
        !/^[0-9a-f]{40}$/.test(component.sourceRevision))
      fail(`${location}.sourceRevision must be a full Git commit`);
    if (component.npmPackage !== undefined) {
      requireText(component.npmPackage, `${location}.npmPackage`);
      requireText(component.npmIntegrity, `${location}.npmIntegrity`);
      const separator = component.npmPackage.lastIndexOf("@");
      if (separator <= 0)
        fail(`${location}.npmPackage must include an exact version`);
      const packageName = component.npmPackage.slice(0, separator);
      const packageVersion = component.npmPackage.slice(separator + 1);
      if (packageVersion !== component.version)
        fail(`${location}.npmPackage version does not match component.version`);
      const lockedPackage =
        packageLock.packages?.[`node_modules/${packageName}`];
      if (!lockedPackage)
        fail(`${component.npmPackage} is missing from package-lock.json`);
      if (lockedPackage.version !== packageVersion)
        fail(`${component.npmPackage} version differs in package-lock.json`);
      if (lockedPackage.integrity !== component.npmIntegrity)
        fail(`${component.npmPackage} integrity differs in package-lock.json`);
    }
    if (!Array.isArray(component.files) || component.files.length === 0)
      fail(`${location}.files must not be empty`);

    const expected = new Set(component.lockPaths || []);
    for (const tree of component.lockTrees || []) {
      const directory = safePath(root, tree);
      for (const filename of walk(directory)) {
        expected.add(
          path.relative(root, filename).split(path.sep).join("/")
        );
      }
    }
    const recorded = new Set(component.files.map(artifact => artifact.path));
    for (const artifact of expected) {
      if (!recorded.has(artifact))
        fail(`${location} is missing locked input: ${artifact}`);
    }
    for (const artifact of recorded) {
      if (!expected.has(artifact))
        fail(`${location} records undeclared input: ${artifact}`);
    }

    for (const artifact of component.files) {
      requireText(artifact.path, `${location}.files[].path`);
      if (listed.has(artifact.path))
        fail(`Artifact is listed more than once: ${artifact.path}`);
      listed.add(artifact.path);

      if (!/^[0-9a-f]{64}$/.test(artifact.sha256 || ""))
        fail(`Invalid SHA-256 for ${artifact.path}`);
      if (!Number.isSafeInteger(artifact.size) || artifact.size < 0)
        fail(`Invalid size for ${artifact.path}`);

      const filename = safePath(root, artifact.path);
      if (!fs.existsSync(filename))
        fail(`Missing artifact: ${artifact.path}`);
      if (!fs.lstatSync(filename).isFile())
        fail(`Artifact is not a regular file: ${artifact.path}`);
      const actualSize = fs.statSync(filename).size;
      if (actualSize !== artifact.size)
        fail(`Size mismatch for ${artifact.path}: expected ${artifact.size}, got ${actualSize}`);
      const actualHash = sha256(filename);
      if (actualHash !== artifact.sha256)
        fail(`SHA-256 mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actualHash}`);
      verified++;
    }
  }

  for (const artifact of discoverProtectedArtifacts(root)) {
    if (!listed.has(artifact))
      fail(`Vendored artifact is not locked: ${artifact}`);
  }

  for (const mirror of lock.mirrors || []) {
    const source = safePath(root, mirror.source);
    const destination = safePath(root, mirror.destination);
    if (!fs.existsSync(source) || !fs.existsSync(destination))
      fail(`Missing mirrored artifact: ${mirror.source} -> ${mirror.destination}`);
    if (!fs.readFileSync(source).equals(fs.readFileSync(destination)))
      fail(`Mirrored artifact differs: ${mirror.source} -> ${mirror.destination}`);
  }

  if (!quiet)
    console.log(`Verified ${verified} vendored artifacts.`);
  return { verified };
}

if (require.main === module) {
  try {
    verifyArtifacts();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { discoverProtectedArtifacts, verifyArtifacts };
