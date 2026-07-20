# TeX for Gmail

[![CI](https://github.com/TomasOrtega/TeX-for-Gmail/actions/workflows/ci.yml/badge.svg)](https://github.com/TomasOrtega/TeX-for-Gmail/actions/workflows/ci.yml)
[![CodeQL](https://github.com/TomasOrtega/TeX-for-Gmail/actions/workflows/codeql.yml/badge.svg)](https://github.com/TomasOrtega/TeX-for-Gmail/actions/workflows/codeql.yml)
[![Firefox 142+](https://img.shields.io/badge/Firefox-142%2B-FF7139?logo=firefoxbrowser&logoColor=white)](targets/firefox/manifest.json)
[![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-4285F4?logo=googlechrome&logoColor=white)](targets/chrome/manifest.json)
[![Privacy: local processing](https://img.shields.io/badge/privacy-local%20processing-2ea44f)](PRIVACY.md)
[![Reproducible releases](https://img.shields.io/badge/releases-reproducible-2ea44f)](docs/RELEASING.md)
[![Security policy](https://img.shields.io/badge/security-policy-2ea44f)](SECURITY.md)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue.svg)](LICENSE)

A Firefox and Chrome extension that renders TeX-style math in Gmail drafts.
Rendering runs locally with a packaged MathJax renderer, and the resulting PNG
is inserted into the message. Recipients do not need the extension.

This project is independent of the similarly named add-on published by Valery
Alexeev. See [AUTHORS](AUTHORS) for project credits.

## Use

Open a Gmail draft. A ∑ button appears in its formatting toolbar, beside the
standard controls such as **Bold**. Write math with delimiters, then click ∑ to
render the delimited expressions in that draft. For responsiveness, one click
handles up to 50 expressions; click it again to continue with a larger draft.

Inline delimiters (`$…$` and `\(...\)`) and display delimiters (`$$…$$` and
`\[…\]`) are recognized. Plain text is never guessed to be math. To edit a
rendered expression, delete it with Backspace or Delete, or double-click it;
the original delimited source is restored before normal text editing resumes.
That reversible source is held only in memory for the current compose page and
is not embedded in the sent image.

MathJax is loaded only when a formula is requested, so the extension does not
add a rendering workload to ordinary browsing. The first render can be
slightly slower while the local renderer starts. Formula source and email
content are not sent to a compilation service, analytics service, or CDN. See
[Privacy](PRIVACY.md) for the complete data-handling policy.

MathJax supports common TeX and LaTeX math notation, including the configured
AMS and macro features. It is not a general TeX engine: it does not compile
documents, load arbitrary TeX packages, execute shell commands, or render
TikZ.

## Develop

Requirements: Node.js 22.9 or newer. Running a staged extension requires
Firefox 142 or newer for the Firefox target, or Chrome 116 or newer for the
Chrome target.

```sh
npm ci --ignore-scripts
npm test
npm run test:coverage
npm run lint
npm run stage:firefox
```

`npm run validate` verifies vendored dependencies and release metadata, runs
the coverage-gated test suite, lints the Firefox target, builds both targets,
compares both ZIPs with their staged source trees, exercises the renderer under
the production CSP in Chrome, and audits dependencies.

Core coverage means every authored runtime JavaScript file under
`chrome-extension/src/`. CI requires 100% line coverage for that complete set.
Vendored renderer code and repository maintenance scripts are outside the
runtime coverage gate and have separate integrity and behavior checks.

The authored extension source is shared under `chrome-extension/`. Target
manifests live under `targets/firefox/` and `targets/chrome/`; generated staging
trees under `build/` should not be edited.

For a one-off Firefox install:

```sh
npm run stage:firefox
```

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
and select `build/firefox/manifest.json`. Temporary add-ons are removed when
Firefox exits.

For a one-off Chrome install:

```sh
npm run stage:chrome
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
and select the `build/chrome` directory.
After reloading the unpacked extension, refresh every open Gmail tab too;
Chrome keeps the previous content script until that tab navigates.

Build both target ZIPs with:

```sh
npm run build
```

Use `npm run build:firefox` or `npm run build:chrome` to build only one target.
Artifacts are written to `dist/tex-for-gmail-firefox-<version>.zip` and
`dist/tex-for-gmail-chrome-<version>.zip`.

## Production and releases

The local renderer consists of exact files from lockfile-pinned `@mathjax/src`
and `@mathjax/mathjax-newcm-font` releases. Runtime artifacts and their
provenance are recorded in
[`artifacts.lock.json`](artifacts.lock.json); validation rejects missing,
changed, or unexpected vendored files.

The extension packages only the 14 MathJax runtime, font, and license files
needed by its tested feature set—not either complete npm package. They remain
local because extension stores prohibit remotely hosted executable code, and
local files preserve offline rendering, privacy, and reproducible review.

`npm run release:artifacts` enforces the full validation suite, a clean
worktree, and a `v<version>` tag on `HEAD`. Firefox and Chrome are
separate store submissions: Mozilla signs the Firefox package, while the
Chrome package is submitted independently to the Chrome Web Store. See the
[release process](docs/RELEASING.md),
[Mozilla reviewer notes](docs/AMO_REVIEW.md), and
[Chrome Web Store reviewer notes](docs/CWS_REVIEW.md).

## Architecture

- Both targets share the Gmail toolbar integration, controller, and local
  MathJax renderer. The build supplies the target manifest and browser-specific
  runtime host.
- Firefox uses a Manifest V2 non-persistent background page. Chrome uses a
  Manifest V3 service worker and creates a packaged offscreen document when
  Gmail first requests rendering.
- MathJax is loaded lazily. Chrome closes its offscreen renderer after five
  idle minutes; Firefox can unload its non-persistent background page when no
  Gmail runtime port remains.
- The Gmail content script sends only the requested formula and rendering
  options over an extension runtime port, then inserts a self-contained PNG
  data URL into the active editor.
- Only `https://mail.google.com/` is supported.

See [Contributing](CONTRIBUTING.md) for development expectations,
[Support](SUPPORT.md) for help, [Security](SECURITY.md) for vulnerability
reporting, and the
[third-party notices](chrome-extension/THIRD_PARTY_NOTICES.md) for bundled
software terms.

Original project code is GPL-3.0-only. MathJax components retain their
Apache-2.0 terms.
