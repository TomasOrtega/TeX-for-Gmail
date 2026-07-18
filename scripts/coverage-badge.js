"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const lcovPath = path.join(root, "coverage", "lcov.info");
const badgePath = path.join(root, ".github", "badges", "coverage.svg");
const coreDirectories = [
  "chrome-extension/popup",
  "chrome-extension/src"
];

function discoverCoreSources() {
  return coreDirectories.flatMap(directory => {
    const absoluteDirectory = path.join(root, directory);
    return fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".js"))
      .map(entry => `${directory}/${entry.name}`);
  }).sort();
}

function normalizeSource(source) {
  const relative = path.isAbsolute(source)
    ? path.relative(root, source)
    : source;
  return relative.split(path.sep).join("/");
}

function coreCoverage(lcov, requiredSources = discoverCoreSources()) {
  const required = new Set(requiredSources);
  const records = new Map();
  let currentSource;

  for (const line of lcov.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      currentSource = normalizeSource(line.slice(3));
      if (required.has(currentSource) && !records.has(currentSource))
        records.set(currentSource, { hit: 0, total: 0 });
      continue;
    }

    const totalMatch = /^LF:(\d+)$/.exec(line);
    if (totalMatch && records.has(currentSource)) {
      records.get(currentSource).total += Number(totalMatch[1]);
      continue;
    }

    const hitMatch = /^LH:(\d+)$/.exec(line);
    if (hitMatch && records.has(currentSource))
      records.get(currentSource).hit += Number(hitMatch[1]);
  }

  const missing = requiredSources.filter(source => !records.has(source));
  if (missing.length > 0)
    throw new Error(`LCOV is missing required sources: ${missing.join(", ")}`);

  let hit = 0;
  let total = 0;
  for (const [source, record] of records) {
    if (record.total === 0 || record.hit > record.total)
      throw new Error(`Invalid LCOV line totals for ${source}`);
    hit += record.hit;
    total += record.total;
  }

  return {
    hit,
    percent: hit / total * 100,
    total
  };
}

function requireCompleteCoverage(coverage) {
  if (coverage.hit !== coverage.total) {
    throw new Error(
      `Core line coverage is ${coverage.percent.toFixed(2)}% ` +
      `(${coverage.hit}/${coverage.total}); expected 100%.`
    );
  }
}

function badgeColor(percent) {
  if (percent >= 90)
    return "#4c1";
  if (percent >= 80)
    return "#97ca00";
  if (percent >= 70)
    return "#a4a61d";
  if (percent >= 60)
    return "#dfb317";
  if (percent >= 50)
    return "#fe7d37";
  return "#e05d44";
}

function renderBadge(percent) {
  const message = `${percent.toFixed(0)}%`;
  const color = badgeColor(percent);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20" role="img" aria-label="core line coverage: ${message}">
  <title>core line coverage: ${message}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".7"/>
    <stop offset=".1" stop-color="#aaa" stop-opacity=".1"/>
    <stop offset=".9" stop-color="#000" stop-opacity=".3"/>
    <stop offset="1" stop-color="#000" stop-opacity=".5"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="120" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="68" height="20" fill="#555"/>
    <rect x="68" width="52" height="20" fill="${color}"/>
    <rect width="120" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text aria-hidden="true" x="34" y="15" fill="#010101" fill-opacity=".3">core lines</text>
    <text x="34" y="14">core lines</text>
    <text aria-hidden="true" x="94" y="15" fill="#010101" fill-opacity=".3">${message}</text>
    <text x="94" y="14">${message}</text>
  </g>
</svg>
`;
}

function main() {
  const mode = process.argv[2];
  if (!["--check", "--write"].includes(mode))
    throw new Error("Usage: coverage-badge.js --check|--write");

  const coverage = coreCoverage(fs.readFileSync(lcovPath, "utf8"));
  requireCompleteCoverage(coverage);
  const expected = renderBadge(coverage.percent);

  if (mode === "--write") {
    fs.mkdirSync(path.dirname(badgePath), { recursive: true });
    fs.writeFileSync(badgePath, expected);
    console.log(`Updated coverage badge to ${coverage.percent.toFixed(1)}%.`);
    return;
  }

  const current = fs.existsSync(badgePath)
    ? fs.readFileSync(badgePath, "utf8")
    : "";
  if (current !== expected) {
    throw new Error(
      `Coverage badge is stale (${coverage.percent.toFixed(1)}%). ` +
      "Run npm run coverage:update."
    );
  }

  console.log(`Coverage badge is current at ${coverage.percent.toFixed(1)}%.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  coreCoverage,
  discoverCoreSources,
  requireCompleteCoverage
};
