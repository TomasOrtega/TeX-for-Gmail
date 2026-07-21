"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  EXPECTED_WARNINGS,
  lintFirefox,
  runAddonsLinter,
  validateLintReport
} = require("../scripts/lint-extension.js");

function digest(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tex-gmail-lint-"));
  const sourceDir = path.join(root, "build", "firefox");
  const contents = new Map([
    [
      "resources/mathjax/input/tex/extensions/begingroup.js",
      Buffer.from("locked begingroup")
    ],
    [
      "resources/mathjax/input/tex/extensions/boldsymbol.js",
      Buffer.from("locked boldsymbol")
    ],
    [
      "resources/mathjax/tex-svg.js",
      Buffer.from("locked tex-svg")
    ]
  ]);
  const files = [];

  for (const [relative, data] of contents) {
    const filename = path.join(sourceDir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, data);
    files.push({
      path: `chrome-extension/${relative}`,
      sha256: digest(data),
      size: data.length
    });
  }
  fs.writeFileSync(
    path.join(root, "artifacts.lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      components: [{ files }]
    })
  );
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return { root, sourceDir };
}

function report(overrides = {}) {
  return {
    errors: [],
    notices: [],
    warnings: EXPECTED_WARNINGS.flatMap(expectation => {
      const { count, ...warning } = expectation;
      return Array.from({ length: count }, (_, index) => ({
        ...warning,
        column: index + 1,
        line: index + 1
      }));
    }),
    ...overrides
  };
}

test("the project depends on the linter directly, without web-ext", () => {
  const root = path.join(__dirname, "..");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  );
  const packageLock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8")
  );

  assert.equal(packageJson.devDependencies["addons-linter"], "10.9.0");
  assert.equal(packageJson.devDependencies["web-ext"], undefined);
  assert.equal(packageJson.scripts["start:firefox"], undefined);
  assert.equal(
    packageLock.packages["node_modules/addons-linter"].version,
    "10.9.0"
  );
  assert.equal(packageLock.packages["node_modules/web-ext"], undefined);
});

test("integrity-locked MathJax warning counts ignore minified offsets", t => {
  const context = fixture(t);

  assert.deepEqual(
    validateLintReport({ ...context, report: report() }),
    { warnings: 10 }
  );
});

test("new, duplicate, and missing warnings fail closed", t => {
  const context = fixture(t);
  const unexpected = {
    code: "DANGEROUS_EVAL",
    column: 1,
    file: "src/background.js",
    line: 1
  };

  assert.throws(
    () => validateLintReport({
      ...context,
      report: report({ warnings: [...report().warnings, unexpected] })
    }),
    /Unexpected addons-linter warning.*src\/background\.js/
  );
  assert.throws(
    () => validateLintReport({
      ...context,
      report: report({
        warnings: [...report().warnings, report().warnings[0]]
      })
    }),
    /Unexpected addons-linter warning/
  );
  assert.throws(
    () => validateLintReport({
      ...context,
      report: report({ warnings: report().warnings.slice(1) })
    }),
    /Expected addons-linter warning is missing/
  );
});

test("errors and notices fail closed", t => {
  const context = fixture(t);

  assert.throws(
    () => validateLintReport({
      ...context,
      report: report({ errors: [{ code: "MANIFEST_FIELD_REQUIRED" }] })
    }),
    /reported 1 error/
  );
  assert.throws(
    () => validateLintReport({
      ...context,
      report: report({ notices: [{ code: "NEW_NOTICE" }] })
    }),
    /reported 1 unexpected notice/
  );
});

test("changed or unlocked warned files fail integrity verification", t => {
  const context = fixture(t);
  fs.writeFileSync(
    path.join(context.sourceDir, "resources", "mathjax", "tex-svg.js"),
    "changed"
  );

  assert.throws(
    () => validateLintReport({ ...context, report: report() }),
    /SHA-256 mismatch for lint warning file/
  );

  const unlockedContext = fixture(t);
  const lockPath = path.join(unlockedContext.root, "artifacts.lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.components[0].files = lock.components[0].files.filter(artifact =>
    !artifact.path.endsWith("/boldsymbol.js")
  );
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  assert.throws(
    () => validateLintReport({
      ...unlockedContext,
      report: report()
    }),
    /Lint warning file is not integrity-locked/
  );
});

test("addons-linter is invoked directly in JSON mode", t => {
  const context = fixture(t);
  let invocation;
  const result = runAddonsLinter({
    ...context,
    spawn(command, args, options) {
      invocation = { args, command, options };
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify(report())
      };
    }
  });

  assert.equal(invocation.command, process.execPath);
  assert.match(
    invocation.args[0],
    /node_modules\/addons-linter\/bin\/addons-linter$/
  );
  assert.deepEqual(invocation.args.slice(1), [
    "--output",
    "json",
    "--boring",
    context.sourceDir
  ]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.report.warnings, report().warnings);
});

test("the production lint command stages Firefox and checks exit status", t => {
  const context = fixture(t);
  let stageOptions;

  assert.deepEqual(
    lintFirefox({
      root: context.root,
      quiet: true,
      stage(options) {
        stageOptions = options;
        return { stageRoot: context.sourceDir };
      },
      run() {
        return { report: report(), status: 0 };
      }
    }),
    { warnings: 10 }
  );
  assert.deepEqual(stageOptions, {
    root: context.root,
    target: "firefox",
    quiet: true
  });

  assert.throws(
    () => lintFirefox({
      root: context.root,
      quiet: true,
      stage() {
        return { stageRoot: context.sourceDir };
      },
      run() {
        return { report: report(), status: 2 };
      }
    }),
    /addons-linter exited with status 2/
  );
});

test("invalid addons-linter output fails closed", t => {
  const context = fixture(t);

  assert.throws(
    () => runAddonsLinter({
      ...context,
      spawn() {
        return {
          status: 1,
          stderr: "lint failed",
          stdout: "not json"
        };
      }
    }),
    /did not return valid JSON.*lint failed/
  );
});
