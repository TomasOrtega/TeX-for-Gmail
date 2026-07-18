# Notes for Mozilla reviewers

## Functionality

1. Load the extension and open a Gmail draft.
2. Place the cursor in the message body.
3. Select `\frac{1}{2}`, then use **Render LaTeX** from the context menu.
4. Confirm that a rendered PNG is inserted into the draft.

The toolbar popup and <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> command
exercise the same local rendering path.

## Permissions and data

- `https://mail.google.com/*` lets the content script read the selected
  formula or explicit popup input and insert the resulting image.
- `contextMenus` provides the selection action.
- The extension declares no data collection. It has no analytics or
  extension-operated service.
- TeX Live, pdfTeX, and MuPDF resources are packaged. Rendering makes no CDN
  or remote-code request.

The background page is non-persistent. Bounded workers are created only after
a render request, and timed-out workers are terminated.

## Source and generated artifacts

From the submitted source archive:

```sh
npm ci --ignore-scripts
npm run validate
```

`package-lock.json` pins official npm packages. BrowserFS and MuPDF vendor
checks reproduce their packaged files, and `artifacts.lock.json` records the
size and SHA-256 digest of every generated or vendored artifact. Tests compile
the packaged AMS fixture and rasterize a PDF with packaged MuPDF.

The historical pdfTeX bitcode and prebuilt LaTeX format do not yet have
sufficient source and toolchain provenance for submission. The complete
package-specific TeX source and license inventory is also unfinished. These
notes must not be used for a production submission until the blockers in
[the release guide](RELEASING.md) are resolved.
