# Release process

The build produces separate Firefox and Chrome store packages from one shared
source tree. The provenance, corresponding-source, and third-party license
blockers below apply to both targets. Do not submit either package to a store
or describe it as production-ready until they are resolved.

Create release candidates from a clean checkout with a supported Node.js
version.

1. Review every changed generated artifact and its source.
2. Update `artifacts.lock.json` with the component version, source, provenance,
   byte size, and SHA-256 digest.
3. Run the release gates:

   ```sh
   npm ci --ignore-scripts
   npm run validate
   ```

4. Inspect both target packages and confirm that each manifest version matches
   the intended release:

   - `dist/tex-for-gmail-firefox-<version>.zip`
   - `dist/tex-for-gmail-chrome-<version>.zip`

5. Confirm that each ZIP reproduces from the same reviewed commit and contains
   only its target manifest and runtime host files.
6. Follow the target-specific submission process below.

`npm run validate` reproduces vendored npm files, checks version consistency,
required licensing files, Firefox and Chrome distribution metadata, forbidden
package files, artifact coverage, hashes, and build-output mirrors; enforces
100% line coverage across all first-party runtime JavaScript; runs the Firefox
linter; builds both ZIPs; compares every archived file to its reviewed staged
tree; and audits dependencies.

## Firefox submission

Submit `dist/tex-for-gmail-firefox-<version>.zip`, a matching source archive,
and the reproducible build instructions under Mozilla's
[source-code submission requirements](https://extensionworkshop.com/documentation/publish/source-code-submission/)
for review and signing. Include the relevant details from
[the Mozilla reviewer notes](AMO_REVIEW.md). The source upload is mandatory
because the package contains minified and machine-generated JavaScript and
WebAssembly. Do not distribute an unsigned development build as a Firefox
release.

## Chrome submission

Submit `dist/tex-for-gmail-chrome-<version>.zip` as a separate Chrome Web Store
item and include the relevant details from
[the Chrome reviewer notes](CWS_REVIEW.md). Retain the matching source archive,
lockfile, artifact records, and build instructions for review. The Manifest V3
package contains all executable code locally; review it against the Chrome Web
Store's
[additional Manifest V3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
and complete the independent
[Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process).
Do not distribute a development ZIP as a Chrome release.

## Generated code

Never update a checksum merely to make verification pass. Record the upstream
version and source revision, retain the corresponding source and build recipe,
review the resulting diff, and then update the lock.

`wasm/pdflatex/build.sh` copies its outputs into the extension only after a
successful build. BrowserFS and MuPDF are reproduced from exact npm packages by
their vendor scripts. The historical `pdftex.bc` input does not have a complete
upstream source revision and supported build recipe. The packaged
`pdflatex.fmt` is also prebuilt; its complete format-generation inputs and
recipe are absent. These provenance gaps are documented in
`artifacts.lock.json` and must be resolved before a production release.
Reproducing an artifact only with an unsupported historical toolchain is not
sufficient for Mozilla source review.

In the Mozilla reviewer notes, follow Mozilla's
[third-party library guidance](https://extensionworkshop.com/documentation/publish/third-party-library-usage/):
link every component to the exact release source recorded in
`artifacts.lock.json` and explain the deterministic BrowserFS CSP patch.
Give the Chrome Web Store the equivalent provenance and local-code explanation
in `CWS_REVIEW.md`.

MuPDF is AGPL-3.0-or-later software included in a GPL-3.0 project. Before
distribution, confirm the combined licensing posture and make MuPDF's complete
corresponding source for the locked revision available with the release.

The TeX Live summary licenses are not a substitute for package-specific terms.
Before distribution, inventory every component embedded in `pdflatex.fmt` and
every packaged macro and font, then include the required source bundles,
copyright notices, and license texts. In particular, the current source subset
does not include all source files required by the LaTeX base, Tools, preview,
standalone, and xkeyval distribution notices.

## Packaged TeX files

`scripts/vendor-texlive.js` reproduces the packaged TeX Live subset from the
full Git commit recorded in `artifacts.lock.json`. The extension makes no
runtime TeX download. Any data-set update must change the vendor script and
lock together, then pass the release validator and local render smoke test.
