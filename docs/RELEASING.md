# Release process

The repository produces separate Firefox and Chrome packages from one shared
source tree. Create releases with Node.js 22.9 or newer and Chrome available
for the browser smoke test.

1. Set the same three-part version in `package.json` and both target manifests,
   then refresh `package-lock.json`.
2. If a vendored dependency changed, review its official release and license,
   update to an exact version, run `npm run vendor:mathjax`, inspect the diff,
   and run `npm run artifacts:update`.
3. Install and validate from the lockfile:

   ```sh
   npm ci --ignore-scripts
   npm run validate
   ```

4. Commit the version, create the exact `v<version>` tag on that commit, and
   build the release set:

   ```sh
   npm run release:artifacts
   ```

   This command reruns `npm run validate` and refuses a dirty, untagged, or
   incorrectly tagged checkout.

5. Inspect:

   - `dist/tex-for-gmail-firefox-<version>.zip`
   - `dist/tex-for-gmail-chrome-<version>.zip`
   - `dist/tex-for-gmail-source-<version>.zip`
   - `dist/SHA256SUMS`

6. Load the packaged targets as a temporary Firefox add-on and an unpacked
   Chrome extension. In each browser, use Gmail's ∑ compose-toolbar button to
   render an accented delimited formula such as
   `$\text{café} \subset \mathbb{R}$`, then use Backspace or Delete to restore
   the source. Record the browser versions and result in the release notes.

The source ZIP is deterministic and uses an explicit allowlist of Git-tracked
source, tests, build scripts, documentation, and project metadata. It excludes
`node_modules`, build output, coverage output, and secret-like filenames.
Confirm that it reproduces both target ZIPs before submission.

`npm run validate` checks exact vendored files, licensing and release metadata,
version consistency, package size and file-count budgets, 100% line coverage
across first-party runtime JavaScript, Firefox lint, deterministic target ZIPs,
a local-only renderer smoke under the production CSP in Chrome, and the
dependency audit. Installed-extension behavior is covered by the required
manual release check above.

## Firefox submission

Submit the Firefox ZIP, matching source ZIP, and build instructions under
Mozilla's
[source-code submission requirements](https://extensionworkshop.com/documentation/publish/source-code-submission/).
Include [the Mozilla reviewer notes](AMO_REVIEW.md). Mozilla must sign the
release package.

## Chrome submission

Submit the Chrome ZIP as a separate Chrome Web Store item and use
[the Chrome reviewer notes](CWS_REVIEW.md). Confirm that store privacy
disclosures match `PRIVACY.md`.

The Manifest V3 package contains all executable code locally. Review it against
the Chrome Web Store
[Manifest V3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
and
[user data policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

## Vendored renderer

The runtime contains exact files from lockfile-pinned `@mathjax/src` and
`@mathjax/mathjax-newcm-font` packages. Do not edit them by hand.
`scripts/vendor-mathjax.js --check` compares every submitted file byte-for-byte
with the installed npm package, while `artifacts.lock.json` records package
integrities, file sizes, and SHA-256 digests.

Never update a checksum merely to make verification pass. The extension
package must retain the Apache-2.0 terms, and the source package must retain the
exact lockfile and vendor recipe needed to reproduce all third-party runtime
files.
