"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const workflow = fs.readFileSync(
  path.join(root, ".github", "workflows", "ci.yml"),
  "utf8"
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
);

function workflowStep(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const contentStart = start + marker.length;
  const nextStep = workflow.indexOf("\n      - name: ", contentStart);
  return workflow.slice(
    contentStart,
    nextStep === -1 ? workflow.length : nextStep
  );
}

test("CI covers the minimum and current LTS Node.js releases", () => {
  assert.match(workflow, /node-version: "22\.9\.0"\n\s+label: minimum/);
  assert.match(workflow, /node-version: "24"\n\s+label: LTS/);
  assert.match(
    workflowStep("Set up Node.js"),
    /node-version: \$\{\{ matrix\.node-version \}\}/
  );
});

test("CI installs and asserts the declared npm version", () => {
  const [, npmVersion] = packageJson.packageManager.match(/^npm@(.+)$/) || [];
  assert.ok(npmVersion, "packageManager must declare an npm version");
  assert.match(
    workflowStep("Install declared npm version"),
    new RegExp(`npm install --global npm@${npmVersion.replaceAll(".", "\\.")}`)
  );
  assert.match(
    workflowStep("Assert declared npm version"),
    new RegExp(`npm --version\\)\" = \"${npmVersion.replaceAll(".", "\\.")}\"`)
  );
});

test("CI runs costly validation once without narrowing compatibility coverage", () => {
  for (const name of [
    "Verify vendored dependencies",
    "Verify generated icons",
    "Verify release inputs",
    "Enforce 100% core line coverage",
    "Lint extension",
    "Smoke-test local rendering in Chrome",
    "Audit dependencies"
  ])
    assert.match(workflowStep(name), /if: matrix\.full_validation/);

  assert.match(
    workflowStep("Run tests"),
    /if: \$\{\{ !matrix\.full_validation \}\}/
  );
  for (const name of ["Build extension", "Verify built ZIP"])
    assert.doesNotMatch(workflowStep(name), /if:/);
});

test("CI actions remain pinned to immutable revisions", () => {
  const actions = [...workflow.matchAll(/^\s+uses: (.+)$/gm)];
  assert.ok(actions.length > 0);
  for (const [, action] of actions)
    assert.match(action, /^[^\s@]+@[0-9a-f]{40}(?:\s+# .+)?$/);
});
