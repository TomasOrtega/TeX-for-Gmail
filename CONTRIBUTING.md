# Contributing

Use Node.js 22.9 or newer and install the exact locked dependencies:

```sh
npm ci --ignore-scripts
npm run validate
```

Changes to rendering behavior should include a focused regression test. Run
`npm run coverage:update` when coverage changes so the committed badge remains
in sync. `npm run test:coverage` requires 100% line coverage for every
first-party runtime JavaScript file in `chrome-extension/src/`. Do not exclude
a runtime file to satisfy the gate.

The Firefox and Chrome packages are generated from the shared
`chrome-extension/` tree plus the manifest in `targets/<browser>/`. Do not edit
`build/firefox/` or `build/chrome/`; regenerate them with:

```sh
npm run stage
```

Use `npm run stage:firefox` or `npm run stage:chrome` when testing only one
target. To test Firefox, open
`about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and
select `build/firefox/manifest.json`. To test Chrome, stage it, open
`chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and
select `build/chrome`.

Browser-specific changes must preserve the shared rendering behavior and
include target-specific tests where lifecycle or manifest behavior differs.
Firefox uses a Manifest V2 non-persistent background page. Chrome uses a
Manifest V3 service worker and an offscreen document to host the same local
MathJax renderer.

Runtime code and data must remain self-contained. Do not add remote scripts,
remote TeX resources, analytics, or broader host permissions. Vendored and
generated artifacts must have exact source provenance and matching entries in
`artifacts.lock.json`; see [the release guide](docs/RELEASING.md).

Keep pull requests focused and explain any user-visible or permission change.
